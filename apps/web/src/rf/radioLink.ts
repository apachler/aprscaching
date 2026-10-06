// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * radioLink.ts — the browser radio link as one app-wide store. The link to a radio (USB or Bluetooth KISS TNC,
 * soundcard AFSK, Meshtastic node), what it hears, the forward-to-a-gateway path and the transmit consent live
 * here, outside any component, so the link stays up while the user moves around the app: closing Settings,
 * collapsing a group or searching settings never drops the radio. It goes down only on an explicit Disconnect,
 * on the loss of the device, on a change of account, or when the page unloads.
 *
 * Transmit consent lasts one browser session and lives in memory only. The operator grants it in a dialog
 * (asked when a transmit-capable radio connects under a verified callsign, or at the first transmit), for one
 * callsign over one link; it ends on Disconnect, on the loss of the device, on a change of callsign or SSID, on
 * the loss of verification, on signing out, and with the tab. No frame leaves without a live grant. The packet
 * terminal, which opens its own port, asks for and records its transmissions through the same store. Every
 * outgoing frame lands in the session's Recent transmissions (memory only, never sent anywhere) and raises a
 * `tx` event for the top-bar indicator.
 *
 * The store holds no browser globals of its own: the link factory, the forwarder and the local sink are injected,
 * so the lifecycle is testable without a radio.
 */
import type { Packet } from "@aprscaching/shared";
import type { RfFrame, RfLink, TxFrame } from "./kiss.js";
import { aprsTxNote, type TxEntry, type TxFeature, type TxNote } from "./txLog.js";

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
  /** A live transmit grant for the radio link: this session's consent, for the current callsign and link. */
  txOn: boolean;
  /** A live transmit grant for the packet terminal's own port. */
  termTx: boolean;
  /** The packet terminal's open TNC ("the USB TNC"), or null while it has no port open. */
  terminal: string | null;
  /** This session's outgoing frames, newest first, at most TX_KEPT. */
  sent: TxEntry[];
  /** Frames transmitted since the page loaded; the indicator keys its flash on it. */
  txCount: number;
  ssid: string;
  callsign: string;
  verified: boolean;
}

/** Something the user should hear about; the host turns these into toasts. */
export type RadioEvent =
  | { kind: "connected"; link: LinkKind }
  | { kind: "lost"; message: string }
  | { kind: "connect-failed"; message: string }
  | { kind: "forward-failed"; message: string }
  | { kind: "tx"; entry: TxEntry };

/** Who may transmit: a part of the app with a radio port, the callsign it sends as and the words for its link. */
export interface ConsentRequest {
  who: RadioHolder;
  call: string;
  via: string;
}

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
  now?(): number;
}

const FRAMES_KEPT = 100;
/** Recent transmissions keeps this many outgoing frames. */
export const TX_KEPT = 20;
/** Forwarded frames go out in batches: one POST per this many frames, or after this long, whichever comes first. */
export const FLUSH_FRAMES = 20;
const FLUSH_MS = 2000;

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
  /** The callsign each live grant was given for; a grant holds only while that call is still the one sent as. */
  private grants: Partial<Record<RadioHolder, string>> = {};
  private asking: Partial<Record<RadioHolder, Promise<boolean>>> = {};
  private asker: ((r: ConsentRequest) => Promise<boolean>) | null = null;
  private terminalCall = "";
  private txSeq = 0;

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
      termTx: false,
      terminal: null,
      sent: [],
      txCount: 0,
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

  /** Transmit is possible: a live, transmit-capable link, a control-verified callsign and this session's grant. */
  canTransmit(): boolean {
    return this.current != null && this.granted("bridge");
  }

  /** The dialog that asks the operator for transmit consent; the host registers it, null removes it. */
  setConsentAsker(fn: ((r: ConsentRequest) => Promise<boolean>) | null): void {
    this.asker = fn;
  }

  /**
   * Ask for transmit consent unless it is already granted. Resolves true only with a live grant: the operator
   * allowed it and the callsign and link it was asked for are still the ones in use. A second request while the
   * dialog is open shares its answer.
   */
  async requestTx(who: RadioHolder = "bridge"): Promise<boolean> {
    if (this.granted(who)) return true;
    const want = this.txTarget(who);
    if (!want || !this.asker) return false;
    let answer = this.asking[who];
    if (!answer) {
      answer = this.asker({ who, ...want }).catch(() => false);
      this.asking[who] = answer;
      void answer.then(() => {
        delete this.asking[who];
      });
    }
    const ok = await answer;
    const now = this.txTarget(who);
    if (!ok || !now || now.call !== want.call || now.via !== want.via) return this.granted(who);
    this.grants[who] = want.call;
    this.set({});
    return true;
  }

  /** End every transmit grant: the radio link's and the packet terminal's. */
  revokeTx(): void {
    this.grants = {};
    this.set({});
  }

  /** Note the packet terminal's port: open (the words for its TNC and the call it sends as) or closed (null). */
  setTerminal(via: string | null, call = ""): void {
    delete this.grants.terminal;
    this.terminalCall = via ? call.toUpperCase() : "";
    this.set({ terminal: via });
    if (via && this.txTarget("terminal")) void this.requestTx("terminal");
  }

  /** Record one outgoing frame: it joins Recent transmissions and raises a `tx` event for the indicator. */
  recordTx(note: TxNote): void {
    const entry: TxEntry = { ...note, id: ++this.txSeq, at: this.deps.now?.() ?? Date.now() };
    this.set({ sent: [entry, ...this.state.sent].slice(0, TX_KEPT), txCount: this.txSeq });
    this.emit({ kind: "tx", entry });
  }

  clearSent(): void {
    this.set({ sent: [] });
  }

  /** What a part of the app would transmit as, and over what, or null when it cannot transmit at all. */
  private txTarget(who: RadioHolder): { call: string; via: string } | null {
    if (!this.state.verified || this.state.callsign.length < 3) return null;
    if (who === "terminal")
      return this.state.terminal && this.terminalCall ? { call: this.terminalCall, via: this.state.terminal } : null;
    const k = this.state.link;
    // the soundcard modem and a Meshtastic node only receive
    if (k !== "serial" && k !== "ble") return null;
    return { call: this.txCall(), via: `your ${LINK_LABEL[k]}` };
  }

  private granted(who: RadioHolder): boolean {
    const t = this.txTarget(who);
    return t != null && this.grants[who] === t.call;
  }

  /** The callsign this browser transmits under: the base call with the chosen SSID. */
  txCall(): string {
    const base = this.state.callsign.toUpperCase().split("-")[0] ?? "";
    return this.state.ssid && this.state.ssid !== "0" ? `${base}-${this.state.ssid}` : base;
  }

  /**
   * Follow the signed-in identity. A transmit grant holds for the verified callsign it was given under, so a
   * change of callsign or of verification (and signing out) ends it. A different account (or signing out) also
   * ends the link, the forwarding and the session's Recent transmissions: they belong to the callsign that set
   * them up.
   */
  setIdentity(callsign: string, verified: boolean): void {
    const prev = this.state;
    const sameCall = prev.callsign.toUpperCase() === callsign.toUpperCase();
    const txKey = (c: string, v: boolean) => (v ? c.toUpperCase() : null);
    const patch: Partial<RadioState> = { callsign, verified };
    if (txKey(prev.callsign, prev.verified) !== txKey(callsign, verified)) this.grants = {};
    if (!sameCall) {
      patch.sent = [];
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
      delete this.grants.bridge;
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
      // a transmit-capable radio under a verified callsign asks for this session's consent as it connects
      if (this.txTarget("bridge")) void this.requestTx("bridge");
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
    delete this.grants.bridge;
    if (this.state.link || this.state.txOn) this.set({ link: null });
    await l?.disconnect();
  }

  /**
   * Transmit one frame for a part of the app. Without a grant it asks for consent first; it throws when transmit
   * is not allowed, or when the frame names another source than the callsign the grant was given for.
   */
  async transmit(frame: TxFrame, feature: TxFeature): Promise<void> {
    if (!this.canTransmit()) await this.requestTx("bridge");
    const l = this.current;
    if (!l || !this.canTransmit())
      throw new Error("transmit needs a connected radio, a verified callsign and your consent for this tab");
    const as = this.grants.bridge ?? "";
    if (frame.src.toUpperCase() !== as) throw new Error(`transmit is allowed as ${as} only`);
    await l.send(frame);
    this.recordTx(aprsTxNote(frame, feature));
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
  /** Pick the SSID transmitted under; a grant is for one CALL-SSID, so a different one ends it. */
  setSsid(ssid: string): void {
    const before = this.txCall();
    this.state = { ...this.state, ssid: ssid.replace(/[^0-9]/g, "").slice(0, 2) };
    if (this.txCall() !== before) delete this.grants.bridge;
    this.set({});
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
    // the grants follow from the identity, the links and the consent given; the state reports them as they stand
    this.state.txOn = this.current != null && this.granted("bridge");
    this.state.termTx = this.granted("terminal");
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
