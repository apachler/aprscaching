// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * radioLink.ts — the browser radio link as one app-wide store. The link to a radio (USB or Bluetooth KISS TNC,
 * soundcard AFSK, Meshtastic node), what it hears, the forward-to-a-gateway path and the transmit opt-in live
 * here, outside any component, so the link stays up while the user moves around the app: closing Settings,
 * collapsing a group or searching settings never drops the radio. It goes down only on an explicit Disconnect,
 * on the loss of the device, on a change of account, or when the page unloads.
 *
 * The store holds no browser globals of its own: the link factory, the forwarder and the local sink are injected,
 * so the lifecycle is testable without a radio.
 */
import type { Packet } from "@aprscaching/shared";
import type { RfFrame, RfLink, TxFrame } from "./kiss.js";

export type LinkKind = "serial" | "ble" | "audio" | "mesh";

export const LINK_LABEL: Record<LinkKind, string> = {
  serial: "USB radio",
  ble: "Bluetooth radio",
  audio: "Soundcard (AFSK)",
  mesh: "Meshtastic node",
};

/** How the gateway knows forwarded frames come from this operator. */
export type ForwardMode = "signed" | "secret";

export interface RadioState {
  link: LinkKind | null;
  /** A connect is in progress (the browser's device chooser may be open). */
  busy: boolean;
  /** The most recent frames, newest first. */
  frames: RfFrame[];
  /** Frames heard since the link came up. */
  count: number;
  fwdOn: boolean;
  mode: ForwardMode;
  /** The self-host gateway URL; persisted by the host. */
  gatewayUrl: string;
  /** The ingest secret, held in memory for this page's life only. */
  secret: string;
  /** The transmit opt-in; only meaningful for a control-verified callsign. */
  txOn: boolean;
  ssid: string;
  callsign: string;
  verified: boolean;
}

/** Something the user should hear about; the host turns these into toasts. */
export type RadioEvent =
  | { kind: "connected"; link: LinkKind }
  | { kind: "lost"; message: string }
  | { kind: "connect-failed"; message: string }
  | { kind: "forward-failed"; message: string };

type ConnectableLink = RfLink & { connect(): Promise<void> };

export interface RadioDeps {
  makeLink(kind: LinkKind, onFrame: (f: RfFrame) => void, onClose: (err?: Error) => void): ConnectableLink;
  /** Send one batch to a gateway, or null when the forward settings cannot send (no secret yet). */
  forward(packets: Packet[], s: RadioState): Promise<unknown> | null;
  /** The off-grid sink every heard frame also feeds (the field station). */
  feedLocal(f: RfFrame): void;
  /** Persist the gateway URL; the secret is never handed to storage. */
  saveGatewayUrl?(url: string): void;
  /** Turn a connect error into the words the user sees, or null to stay quiet (a cancelled chooser). */
  connectError?(err: Error): string | null;
  setTimer?(fn: () => void, ms: number): unknown;
  clearTimer?(t: unknown): void;
}

const FRAMES_KEPT = 100;
/** Forwarded frames go out in batches: one POST per this many frames, or after this long, whichever comes first. */
export const FLUSH_FRAMES = 20;
export const FLUSH_MS = 2000;

const CANCELLED = /No port selected|chooser|cancel|User cancelled|Permission denied|NotAllowed/i;

export class RadioLinkStore {
  private state: RadioState;
  private current: ConnectableLink | null = null;
  private subs = new Set<() => void>();
  private listeners = new Set<(e: RadioEvent) => void>();
  private queue: Packet[] = [];
  private timer: unknown = null;
  /** Surface a forward error only once per link session. */
  private fwdReported = false;

  constructor(
    private deps: RadioDeps,
    init: { gatewayUrl?: string } = {},
  ) {
    this.state = {
      link: null,
      busy: false,
      frames: [],
      count: 0,
      fwdOn: false,
      mode: "secret",
      gatewayUrl: init.gatewayUrl ?? "",
      secret: "",
      txOn: false,
      ssid: "7",
      callsign: "",
      verified: false,
    };
  }

  getState = (): RadioState => this.state;

  subscribe = (fn: () => void): (() => void) => {
    this.subs.add(fn);
    return () => {
      this.subs.delete(fn);
    };
  };

  onEvent(fn: (e: RadioEvent) => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  /** Transmit is possible: a live link, a control-verified callsign and the operator's opt-in. */
  canTransmit(): boolean {
    return this.state.link != null && this.state.verified && this.state.txOn;
  }

  /** The callsign this browser transmits under: the base call with the chosen SSID. */
  txCall(): string {
    const base = this.state.callsign.toUpperCase().split("-")[0] ?? "";
    return this.state.ssid && this.state.ssid !== "0" ? `${base}-${this.state.ssid}` : base;
  }

  /**
   * Follow the signed-in identity. The transmit opt-in holds for the verified callsign it was given under, so a
   * change of callsign or of verification switches it off. A different account (or signing out) also ends the
   * link and the forwarding: both act under the callsign that set them up.
   */
  setIdentity(callsign: string, verified: boolean): void {
    const prev = this.state;
    const sameCall = prev.callsign.toUpperCase() === callsign.toUpperCase();
    const txKey = (c: string, v: boolean) => (v ? c.toUpperCase() : null);
    const patch: Partial<RadioState> = { callsign, verified };
    if (txKey(prev.callsign, prev.verified) !== txKey(callsign, verified)) patch.txOn = false;
    if (!sameCall) {
      patch.fwdOn = false;
      patch.mode = callsign.length >= 3 ? "signed" : "secret";
    }
    this.set(patch);
    if (!sameCall && prev.callsign) void this.disconnect();
  }

  async connect(kind: LinkKind): Promise<void> {
    if (this.state.busy || this.current) return;
    this.set({ busy: true });
    // A lost link is torn down like a Disconnect; a link already torn down (or never up) reports nothing.
    const onClose = (err?: Error) => {
      if (this.current !== l) return;
      this.current = null;
      this.flush();
      this.set({ link: null });
      void l.disconnect();
      if (err) this.emit({ kind: "lost", message: err.message || "the device went away" });
    };
    const l = this.deps.makeLink(kind, (f) => this.onFrame(f), onClose);
    try {
      await l.connect();
      this.current = l;
      this.fwdReported = false;
      this.set({ link: kind, busy: false, frames: [], count: 0 });
      this.emit({ kind: "connected", link: kind });
    } catch (e) {
      this.set({ busy: false });
      const err = e as Error;
      const message = this.deps.connectError
        ? this.deps.connectError(err)
        : CANCELLED.test(err.message || "")
          ? null
          : err.message;
      if (message) this.emit({ kind: "connect-failed", message });
    }
  }

  /** End the link: an explicit Disconnect, a change of account, or the page going away. */
  async disconnect(): Promise<void> {
    const l = this.current;
    this.current = null;
    this.flush();
    if (this.state.link) this.set({ link: null });
    await l?.disconnect();
  }

  /** Transmit one frame; the caller confirms with the operator first. Throws when transmit is not allowed. */
  async transmit(frame: TxFrame): Promise<void> {
    const l = this.current;
    if (!l || !this.canTransmit()) throw new Error("transmit needs a connected radio and a verified callsign");
    await l.send(frame);
  }

  setForward(on: boolean): void {
    this.fwdReported = false;
    if (!on) this.flush();
    this.set({ fwdOn: on });
  }
  setMode(mode: ForwardMode): void {
    this.flush();
    this.set({ mode });
  }
  setGatewayUrl(url: string): void {
    const u = url.trim();
    this.set({ gatewayUrl: u });
    this.deps.saveGatewayUrl?.(u);
  }
  setSecret(secret: string): void {
    this.set({ secret: secret.trim() });
  }
  setTxOn(on: boolean): void {
    this.set({ txOn: on && this.state.verified });
  }
  setSsid(ssid: string): void {
    this.set({ ssid: ssid.replace(/[^0-9]/g, "").slice(0, 2) });
  }

  /** Send whatever is queued for the gateway now. */
  flush(): void {
    if (this.timer != null) this.deps.clearTimer?.(this.timer);
    this.timer = null;
    if (!this.queue.length) return;
    const batch = this.queue;
    this.queue = [];
    if (!this.state.fwdOn) return;
    const send = this.deps.forward(batch, this.state);
    send?.catch((e: unknown) => {
      if (this.fwdReported) return;
      this.fwdReported = true;
      this.emit({ kind: "forward-failed", message: (e as Error).message });
    });
  }

  private onFrame(f: RfFrame): void {
    this.set({ frames: [f, ...this.state.frames].slice(0, FRAMES_KEPT), count: this.state.count + 1 });
    this.deps.feedLocal(f); // off-grid sink: live stations + local inbox, gateway-independent
    if (!this.state.fwdOn) return;
    this.queue.push(f.packet);
    if (this.queue.length >= FLUSH_FRAMES) this.flush();
    else if (this.timer == null && this.deps.setTimer) this.timer = this.deps.setTimer(() => this.flush(), FLUSH_MS);
    else if (!this.deps.setTimer) this.flush();
  }

  private set(patch: Partial<RadioState>): void {
    this.state = { ...this.state, ...patch };
    for (const fn of this.subs)
      try {
        fn();
      } catch {
        /* a broken subscriber must not stop the others */
      }
  }

  private emit(e: RadioEvent): void {
    for (const fn of this.listeners) fn(e);
  }
}

/** The transmit state in a word: open, off (the operator's choice or a receive-only link) or locked (unverified). */
export function txWord(s: Pick<RadioState, "link" | "verified" | "txOn">): "TX on" | "RX only" | "TX locked" {
  if (!s.verified) return "TX locked";
  if (s.link === "audio" || s.link === "mesh" || !s.txOn) return "RX only";
  return "TX on";
}

/** Which part of the app holds a radio port in this page. */
export type RadioHolder = "bridge" | "terminal";
const holders = new Set<RadioHolder>();

/** Note that a part of the app opened a radio port (or closed it again). */
export function holdRadio(who: RadioHolder, on: boolean): void {
  if (on) holders.add(who);
  else holders.delete(who);
}

const PORT_BUSY = /already open|InvalidStateError|Failed to open|in use|NetworkError/i;

/**
 * The words for a failed open of a radio port. Two parts of the app cannot share one Web Serial port: when the
 * other one holds a port and the open fails as a busy port does, say who has it instead of the browser's raw error.
 */
export function radioBusyText(err: Error, who: RadioHolder): string | null {
  const m = `${err.name ?? ""} ${err.message ?? ""}`;
  if (CANCELLED.test(m)) return null;
  if (!PORT_BUSY.test(m)) return err.message || "the device did not open";
  const other: RadioHolder = who === "bridge" ? "terminal" : "bridge";
  if (holders.has(other))
    return other === "bridge"
      ? "The radio is in use by the RF bridge — disconnect it in Settings → My radio (browser) first."
      : "The radio is in use by the packet terminal — close the TNC there first.";
  return "The radio is in use by another tab or program — close it there first.";
}
