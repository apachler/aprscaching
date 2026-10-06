// SPDX-License-Identifier: MIT
/**
 * session.ts — the multi-channel packet-terminal session core.
 * Holds N connected-mode channels (each a ConnectedLink from @aprscaching/ax25), a monitor of all heard
 * traffic, and per-channel status. Pure + I/O-free: it talks to a injected Transport (KISS/Web Serial
 * in the browser, a fake in tests) and an injected clock, exactly like the ax25 link tests. The React
 * UI renders from `channels` + `monitor` and calls connect/send/disconnect.
 */
import {
  ConnectedLink,
  parseAddr,
  addrStr,
  sameAddr,
  PID_NO_L3,
  type Ax25Frame,
  type Ax25Address,
  type LinkState,
  type LinkConfig,
} from "@aprscaching/ax25";
import { StationRegistry, type StationType } from "./names.js";

/** Where frames go out (the KISS/serial transmitter, or a test sink). */
export interface Transport {
  send(frame: Ax25Frame): void;
}

/** A line in a channel or the monitor. `dir` drives colour: our TX, remote RX, or local system text. */
export interface TermLine {
  dir: "tx" | "rx" | "sys";
  text: string;
  at: number;
}
export interface MonitorLine {
  src: string;
  dst: string;
  type: StationType;
  text: string;
  at: number;
  ui: boolean;
}

export interface Channel {
  id: number;
  remote: Ax25Address;
  remoteCall: string;
  /** Who opened the link: this station (`outgoing`) or the remote one (`incoming`). */
  direction: "incoming" | "outgoing";
  state: LinkState;
  lines: TermLine[];
}

/** What the session reports beyond `notify`: each received line, and each round-trip sample a link takes. */
export interface SessionListener {
  line?(ch: Channel, text: string): void;
  rtt?(ch: Channel, ms: number, kind: "ack" | "poll"): void;
}

/** Decode an info field to text 1:1 by byte (keeps CP437/ANSI bytes intact for the retro font). */
const toText = (b: Uint8Array): string => {
  let s = "";
  for (const x of b) s += String.fromCharCode(x);
  return s;
};
const enc = (s: string): Uint8Array => {
  const a = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) a[i] = s.charCodeAt(i) & 0xff;
  return a;
};

export class TerminalSession {
  channels: Channel[] = [];
  monitor: MonitorLine[] = [];
  private links = new Map<number, ConnectedLink>();
  private nextId = 1;
  readonly local: Ax25Address;
  /**
   * Whether this station may transmit. Off, the session only listens: the monitor records every frame, but no
   * frame leaves (no connect, no answer to an incoming connect, no text, no acknowledgement). The caller turns it
   * on only for a licensed, control-verified callsign.
   */
  private txAllowed = true;
  /** Set by the host to hear received lines and round-trip samples. */
  listener: SessionListener = {};

  constructor(
    myCall: string,
    private transport: Transport,
    private notify: () => void,
    private names = new StationRegistry(),
    private cfg: Partial<LinkConfig> = {},
    private clock: () => number = () => Date.now(),
    private monitorCap = 500,
    // Bound per-channel scrollback and the live channel count so a hostile peer spamming
    // SABMs / a flood of RX lines can't grow memory without limit.
    private lineCap = 2000,
    private channelCap = 64,
  ) {
    this.local = parseAddr(myCall);
  }

  /** Allow or forbid transmitting. Forbidding it also drops the open connections, without a word on the air. */
  allowTransmit(on: boolean): void {
    if (this.txAllowed === on) return;
    this.txAllowed = on;
    if (!on) {
      this.links.clear();
      for (const c of this.channels) c.state = "disconnected";
    }
    this.notify();
  }
  get canTransmit(): boolean {
    return this.txAllowed;
  }

  /** Open a new connected-mode channel to a remote station; returns its id. */
  connect(remoteCall: string): number {
    if (!this.txAllowed) throw new Error("transmit is not allowed: verify your callsign to connect");
    const id = this.makeChannel(parseAddr(remoteCall), "outgoing");
    this.links.get(id)!.connect();
    this.notify();
    return id;
  }

  /** Build a channel + its link (shared by outgoing connect() and incoming-call acceptance). */
  private makeChannel(remote: Ax25Address, direction: Channel["direction"]): number {
    const id = this.nextId++;
    const ch: Channel = { id, remote, remoteCall: addrStr(remote), direction, state: "disconnected", lines: [] };
    const link = new ConnectedLink(
      this.local,
      remote,
      {
        // the one place a frame leaves: nothing does while transmitting is not allowed
        send: (f) => {
          if (this.txAllowed) this.transport.send(f);
        },
        deliver: (info) => {
          const lines = this.append(ch, "rx", toText(info));
          for (const l of lines) if (l) this.listener.line?.(ch, l);
          this.notify();
        },
        state: (s) => {
          ch.state = s;
          this.sys(ch, `*** ${s}`);
          this.notify();
        },
        rtt: (ms, kind) => this.listener.rtt?.(ch, ms, kind),
      },
      this.cfg,
      this.clock,
    );
    this.links.set(id, link);
    this.channels.push(ch);
    return id;
  }

  /** Send a line of text on a channel (CR-terminated, the packet convention). */
  send(id: number, text: string): void {
    const ch = this.channels.find((c) => c.id === id);
    const link = this.links.get(id);
    if (!ch || !link) return;
    this.append(ch, "tx", text);
    link.send(enc(text + "\r"));
    this.notify();
  }

  /**
   * Poll a connected channel's peer once to time the round trip; the sample arrives through `listener.rtt`. False
   * when the channel is not connected, a poll is already out, or transmitting is not allowed.
   */
  probe(id: number): boolean {
    if (!this.txAllowed) return false;
    const done = this.links.get(id)?.probe() ?? false;
    if (done) this.notify();
    return done;
  }

  /** Disconnect (graceful DISC) a channel. */
  disconnect(id: number): void {
    this.links.get(id)?.disconnect();
    this.notify();
  }

  /** Close + forget a channel entirely (after it's down). */
  close(id: number): void {
    this.links.get(id)?.disconnect();
    this.links.delete(id);
    this.channels = this.channels.filter((c) => c.id !== id);
    this.notify();
  }

  /** Reclaim channels whose link is disconnected (bounds growth under a SABM flood). */
  private reapDisconnected(): void {
    for (const c of this.channels.filter((c) => c.state === "disconnected")) {
      this.links.delete(c.id);
    }
    this.channels = this.channels.filter((c) => c.state !== "disconnected");
  }

  /** Feed an inbound frame from the transport: route to its channel + record in the monitor. */
  onFrame(f: Ax25Frame): void {
    this.recordMonitor(f);
    // a connected-mode frame addressed to us → the matching channel's link
    if (f.type !== "UI" && sameAddr(f.dst, this.local)) {
      let ch = this.channels.find((c) => sameAddr(c.remote, f.src));
      // an incoming SABM from a station we have no channel for → accept the call (auto-open a channel).
      // Bound the live channel count — at the cap, first reap any disconnected channels
      // (the UI keeps a just-closed one; only stale ones are collected); if still full, drop the SABM.
      if (!ch && f.type === "SABM" && this.txAllowed) {
        if (this.channels.length >= this.channelCap) this.reapDisconnected();
        if (this.channels.length >= this.channelCap) {
          this.notify();
          return; // at capacity — the peer's SABM retransmit / eventual timeout handles it
        }
        const id = this.makeChannel(f.src, "incoming");
        ch = this.channels.find((c) => c.id === id);
      }
      if (ch) this.links.get(ch.id)?.onReceive(f);
    }
    this.notify();
  }

  /** Tick all links (T1/T3 timers) — call on a periodic clock. */
  poll(): void {
    for (const l of this.links.values()) l.poll();
  }

  // ---- internals ----
  /** Push a line into a channel, trimming the oldest to keep scrollback bounded. */
  private pushLine(ch: Channel, line: TermLine): void {
    ch.lines.push(line);
    if (ch.lines.length > this.lineCap) ch.lines.splice(0, ch.lines.length - this.lineCap);
  }
  /** Append text as lines; returns the lines. */
  private append(ch: Channel, dir: TermLine["dir"], text: string): string[] {
    const lines = text.split(/\r\n|\r|\n/);
    for (const line of lines) this.pushLine(ch, { dir, text: line, at: this.clock() });
    return lines;
  }
  private sys(ch: Channel, text: string): void {
    this.pushLine(ch, { dir: "sys", text, at: this.clock() });
  }
  private recordMonitor(f: Ax25Frame): void {
    const src = addrStr(f.src),
      dst = addrStr(f.dst);
    const payload = f.info ? toText(f.info) : f.type;
    const type = this.names.classify(src, { dest: dst, payload: f.info ? payload : undefined });
    this.monitor.push({ src, dst, type, text: payload, at: this.clock(), ui: f.type === "UI" });
    if (this.monitor.length > this.monitorCap) this.monitor.splice(0, this.monitor.length - this.monitorCap);
  }
}

export { PID_NO_L3 };
