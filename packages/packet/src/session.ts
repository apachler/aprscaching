// SPDX-License-Identifier: MIT
/**
 * session.ts — the multi-channel packet-terminal session core.
 * Holds N connected-mode channels (each a ConnectedLink from @aprsweb/ax25), a monitor of all heard
 * traffic, and per-channel status. Pure + I/O-free: it talks to a injected Transport (KISS/Web Serial
 * in the browser, a fake in tests) and an injected clock, exactly like the ax25 link tests. The React
 * UI renders from `channels` + `monitor` and calls connect/send/disconnect.
 */
import {
  ConnectedLink, parseAddr, addrStr, sameAddr, PID_NO_L3,
  type Ax25Frame, type Ax25Address, type LinkState, type LinkConfig,
} from "@aprsweb/ax25";
import { StationRegistry, type StationType } from "./names.js";

/** Where frames go out (the KISS/serial transmitter, or a test sink). */
export interface Transport { send(frame: Ax25Frame): void }

/** A line in a channel or the monitor. `dir` drives colour: our TX, remote RX, or local system text. */
export interface TermLine { dir: "tx" | "rx" | "sys"; text: string; at: number }
export interface MonitorLine { src: string; dst: string; type: StationType; text: string; at: number; ui: boolean }

export interface Channel {
  id: number;
  remote: Ax25Address;
  remoteCall: string;
  state: LinkState;
  lines: TermLine[];
}

/** Decode an info field to text 1:1 by byte (keeps CP437/ANSI bytes intact for the retro font). */
const toText = (b: Uint8Array): string => { let s = ""; for (const x of b) s += String.fromCharCode(x); return s; };
const enc = (s: string): Uint8Array => { const a = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) a[i] = s.charCodeAt(i) & 0xff; return a; };

export class TerminalSession {
  channels: Channel[] = [];
  monitor: MonitorLine[] = [];
  private links = new Map<number, ConnectedLink>();
  private nextId = 1;
  readonly local: Ax25Address;

  constructor(
    myCall: string,
    private transport: Transport,
    private notify: () => void,
    private names = new StationRegistry(),
    private cfg: Partial<LinkConfig> = {},
    private clock: () => number = () => Date.now(),
    private monitorCap = 500,
  ) { this.local = parseAddr(myCall); }

  /** Open a new connected-mode channel to a remote station; returns its id. */
  connect(remoteCall: string): number {
    const id = this.makeChannel(parseAddr(remoteCall));
    this.links.get(id)!.connect();
    this.notify();
    return id;
  }

  /** Build a channel + its link (shared by outgoing connect() and incoming-call acceptance). */
  private makeChannel(remote: Ax25Address): number {
    const id = this.nextId++;
    const ch: Channel = { id, remote, remoteCall: addrStr(remote), state: "disconnected", lines: [] };
    const link = new ConnectedLink(this.local, remote, {
      send: (f) => this.transport.send(f),
      deliver: (info) => { this.append(ch, "rx", toText(info)); this.notify(); },
      state: (s) => { ch.state = s; this.sys(ch, `*** ${s}`); this.notify(); },
    }, this.cfg, this.clock);
    this.links.set(id, link);
    this.channels.push(ch);
    return id;
  }

  /** Send a line of text on a channel (CR-terminated, the packet convention). */
  send(id: number, text: string): void {
    const ch = this.channels.find((c) => c.id === id); const link = this.links.get(id);
    if (!ch || !link) return;
    this.append(ch, "tx", text);
    link.send(enc(text + "\r"));
    this.notify();
  }

  /** Disconnect (graceful DISC) a channel. */
  disconnect(id: number): void { this.links.get(id)?.disconnect(); this.notify(); }

  /** Close + forget a channel entirely (after it's down). */
  close(id: number): void {
    this.links.get(id)?.disconnect();
    this.links.delete(id);
    this.channels = this.channels.filter((c) => c.id !== id);
    this.notify();
  }

  /** Feed an inbound frame from the transport: route to its channel + record in the monitor. */
  onFrame(f: Ax25Frame): void {
    this.recordMonitor(f);
    // a connected-mode frame addressed to us → the matching channel's link
    if (f.type !== "UI" && sameAddr(f.dst, this.local)) {
      let ch = this.channels.find((c) => sameAddr(c.remote, f.src));
      // an incoming SABM from a station we have no channel for → accept the call (auto-open a channel)
      if (!ch && f.type === "SABM") { const id = this.makeChannel(f.src); ch = this.channels.find((c) => c.id === id); }
      if (ch) this.links.get(ch.id)?.onReceive(f);
    }
    this.notify();
  }

  /** Tick all links (T1/T3 timers) — call on a periodic clock. */
  poll(): void { for (const l of this.links.values()) l.poll(); }

  // ---- internals ----
  private append(ch: Channel, dir: TermLine["dir"], text: string): void {
    for (const line of text.split(/\r\n|\r|\n/)) ch.lines.push({ dir, text: line, at: this.clock() });
  }
  private sys(ch: Channel, text: string): void { ch.lines.push({ dir: "sys", text, at: this.clock() }); }
  private recordMonitor(f: Ax25Frame): void {
    const src = addrStr(f.src), dst = addrStr(f.dst);
    const payload = f.info ? toText(f.info) : f.type;
    const type = this.names.classify(src, { dest: dst, payload: f.info ? payload : undefined });
    this.monitor.push({ src, dst, type, text: payload, at: this.clock(), ui: f.type === "UI" });
    if (this.monitor.length > this.monitorCap) this.monitor.splice(0, this.monitor.length - this.monitorCap);
  }
}

export { PID_NO_L3 };
