// SPDX-License-Identifier: MIT
/**
 * host.ts — the Tool host. Registers tools, activates enabled ones with a capability-
 * limited ToolContext, dispatches events, and collects their contributions (commands, monitor
 * colourisers, decoders). Every context method enforces the tool's granted capabilities; the gated
 * 'tx'/'beacon' surfaces additionally pass an injected TX gate (the control-verification check) at
 * call time — a Tool can never transmit without it, and never touches verify.ts trust.
 *
 * INVARIANT: the host ROUTES, it never interprets. Every method here is a generic verb
 * (register / on / emit / subscribe / store / panel / tx-gate) — none is named after a domain function.
 * All tool BEHAVIOUR lives in the tools themselves; cross-tool cooperation happens only over the
 * IPC bus below, whose payloads are opaque to the host. Never add a `getMheard()`/`getWeather()`-style
 * method — that would pull a tool's function into the platform.
 */
import type { Capability } from "./capabilities.js";
import type { ToolManifest } from "./manifest.js";
import type { Surface } from "./surfaces.js";
import type { PanelSpec } from "./panel.js";
import type { MapLayerSpec } from "./maplayer.js";

/** Lifecycle/monitor events a tool can hook. on_frame carries a heard frame; on_tick is periodic. */
export type ToolEvent = "on_frame" | "on_connect" | "on_disconnect" | "on_beacon" | "on_find" | "on_spot" | "on_tick";
export const TOOL_EVENTS: readonly ToolEvent[] = [
  "on_frame",
  "on_connect",
  "on_disconnect",
  "on_beacon",
  "on_find",
  "on_spot",
  "on_tick",
];
export const isToolEvent = (x: unknown): x is ToolEvent =>
  typeof x === "string" && TOOL_EVENTS.includes(x as ToolEvent);

export interface MonitorColour {
  colorVar?: string;
  hidden?: boolean;
}
export type Colouriser = (line: { src: string; dst: string; text: string }) => MonitorColour | null;
export interface Decoder {
  id: string;
  label: string;
  kind: string;
  decode(input: string): string;
}
export interface BeaconSpec {
  comment: string;
  intervalSec: number;
}

/** The shortest gap between two transmissions of one tool: its requests, its beacon and its session scripts. */
export const TOOL_TX_MIN_GAP_MS = 60_000;
/** The sustained transmit budget of one tool: a bucket of this many transmissions, refilled over an hour. */
export const TOOL_TX_PER_HOUR = 6;
/** The longest APRS status text a tool may send (`>` and up to 62 characters). */
export const TX_STATUS_MAX = 62;
/** The longest APRS message text a tool may send, after `:ADDRESSEE:`. */
export const TX_MESSAGE_MAX = 67;
/** Bus service and topic names only the app may provide or publish: a tool cannot take over a host service. */
export const RESERVED_BUS_PREFIXES = ["session.", "host.", "link."] as const;
/** Topics under a reserved prefix that a tool may publish: requests the app listens for and answers. */
export const TOOL_REQUEST_TOPICS: readonly string[] = ["link.ping.request"];
const reserved = (name: string) => RESERVED_BUS_PREFIXES.some((p) => name.startsWith(p));
const reservedTopic = (name: string) => reserved(name) && !TOOL_REQUEST_TOPICS.includes(name);
/** How long a tool may answer a connected session after the event that offered the reply, and how often. */
export const REPLY_TTL_MS = 120_000;
export const REPLY_MAX = 4;
/** The longest line a reply, or a remote command's output line, sends on a session. */
export const REPLY_TEXT_MAX = 256;
/** A reply as one line within REPLY_TEXT_MAX characters. */
export const replyLine = (t: unknown): string =>
  String(t)
    .replace(/[\r\n\0]+/g, " ")
    .slice(0, REPLY_TEXT_MAX);
/** The shortest beacon interval a tool may schedule: ten minutes, the usual floor for a fixed APRS station. */
export const BEACON_MIN_INTERVAL_SEC = 600;
/** The longest beacon interval: one day. */
export const BEACON_MAX_INTERVAL_SEC = 86_400;
/** The longest APRS information field a tool may transmit. */
export const TX_INFO_MAX = 256;
/** The longest beacon comment: an APRS status text holds 62 characters. */
export const BEACON_COMMENT_MAX = 62;

/**
 * Why an APRS information field a tool asks to transmit is refused, or null when it may go out. A tool transmits
 * an APRS status (`>text`) or an APRS message (`:ADDRESSEE:text`, an acknowledgement included) and nothing else:
 * no position (a status may not start with a grid locator), object, item, telemetry or telemetry definition,
 * bulletin or announcement, or third-party traffic (`}`), which would carry another station's callsign as its
 * source. One line of text, within the status or message length (a message number not counted).
 */
export function txInfoProblem(info: unknown): string | null {
  if (typeof info !== "string") return "the frame must be text";
  if (!info.trim()) return "the frame is empty";
  if (info.length > TX_INFO_MAX) return `the frame is longer than ${TX_INFO_MAX} characters`;
  if (/[\r\n\0]/.test(info)) return "the frame must be one line";
  if (info.startsWith("}")) return "a tool may not send third-party traffic";
  if (info.startsWith(">")) {
    const text = info.slice(1);
    if (text.length > TX_STATUS_MAX) return `a status holds at most ${TX_STATUS_MAX} characters`;
    // a status that starts with a Maidenhead locator reports a position (APRS101 ch. 16), which a tool may not send
    if (/^[A-R]{2}[0-9]{2}/i.test(text)) return "a status may not start with a grid locator";
    return null;
  }
  // `:` + a nine-character addressee of printable ASCII (no `:`), padded with spaces, + `:` + text
  const msg = /^:([!-9;-~][ -9;-~]{8}):(.*)$/.exec(info);
  if (msg) {
    const to = msg[1]!.trimEnd();
    if (/ /.test(to)) return "a message addressee is one word, padded with spaces";
    if (/^(BLN|NWS|SKY|CWA|BOM|NTS)/i.test(to)) return "a tool may not send bulletins or announcements";
    const text = msg[2]!.replace(/\{[A-Za-z0-9]{1,5}\}?$/, ""); // the optional message number
    if (/^(PARM|UNIT|EQNS|BITS)\./.test(text)) return "a tool may not send telemetry definitions";
    if (/[|~{]/.test(text)) return "a message may not hold | ~ or {";
    if (text.length > TX_MESSAGE_MAX) return `a message holds at most ${TX_MESSAGE_MAX} characters`;
    return null;
  }
  return "a tool may transmit only an APRS status (>) or message (:ADDRESSEE:text)";
}

/** Bring an untrusted beacon request into bounds: one-line comment, interval clamped. An error string if unusable. */
export function normalizeBeacon(spec: unknown): BeaconSpec | string {
  const o = spec && typeof spec === "object" ? (spec as Record<string, unknown>) : null;
  if (!o) return "a beacon needs { comment, intervalSec }";
  const comment = typeof o.comment === "string" ? o.comment.replace(/[\r\n\0]+/g, " ").trim() : "";
  if (!comment) return "a beacon needs a comment";
  if (comment.startsWith("}")) return "a tool may not send third-party traffic";
  const sec = Number(o.intervalSec);
  if (!Number.isFinite(sec)) return "a beacon needs an interval in seconds";
  return {
    comment: comment.slice(0, BEACON_COMMENT_MAX),
    intervalSec: Math.round(Math.min(BEACON_MAX_INTERVAL_SEC, Math.max(BEACON_MIN_INTERVAL_SEC, sec))),
  };
}

/**
 * The context an event carries. Every field is optional so
 * a caller supplies what its surface knows; a connected-mode surface fills peerCall/myCall/channel and a
 * `reply` sink, and looks the peer up in the station registry for `station`.
 */
export interface ToolEventPayload {
  surface?: Surface;
  channel?: number;
  peerCall?: string; // the far station (GP {chan}); on_frame → the heard callsign
  myCall?: string; // the local station in use
  source?: string; // on_frame provenance label — "RF" (terminal/TNC), "APRS", …
  station?: { roles?: string[]; [k: string]: unknown } | null; // per-callsign context (account_stations)
  direction?: SessionDirection; // on_connect/on_disconnect: who opened the session
  reply?: (text: string) => void; // send a line back on this channel (PMS/auto-answer)
  [k: string]: unknown;
}

/** Who opened a connected session: the remote station (`incoming`) or this one (`outgoing`). */
export type SessionDirection = "incoming" | "outgoing";
/** A connected session as a surface reports it to the tools in `on_connect` and `on_disconnect`. */
export interface SessionInfo {
  surface: Surface;
  channel: number;
  peerCall: string;
  myCall: string;
  direction: SessionDirection;
}
/** Send one line on a session for a tool: null once it is on its way, else why it was refused. */
export type SessionSend = (text: string, tool: string) => string | null;

/** A cooperative per-host string store (LinPac lp_set_var/get_var) shared by enabled tools. */
export interface ToolStore {
  get(key: string): string | undefined;
  set(key: string, value: string): void;
  keys(): string[];
}

/** An inter-tool bus subscriber: receives an opaque payload + the emitting tool's name. */
export type IpcHandler = (data: unknown, from: string) => void;

/** The host-API surface a tool receives on activation — every method is capability-gated. */
export interface ToolContext {
  granted(cap: Capability): boolean;
  log(msg: string): void;
  /** Register a /word. In a `remote:true` tool, pass `{ remote: false }` to keep this command operator-only. */
  registerCommand(word: string, handler: (args: string) => string[], opts?: { remote?: boolean }): void; // 'command'
  on(event: ToolEvent, handler: (payload: ToolEventPayload) => void): void; // 'event' (on_frame → 'monitor')
  addColouriser(fn: Colouriser): void; // 'monitor'
  addDecoder(d: Decoder): void; // 'decoder'
  setPanel(spec: PanelSpec | null): void; // 'panel' — declarative UI region
  setMapLayer(spec: MapLayerSpec | null): void; // 'map' — declarative marker layer
  /** 'beacon' + TX gate. Replaces this tool's schedule; `null` ends it. Throws when the gate is closed. The host
   *  clamps the interval to BEACON_MIN_INTERVAL_SEC…BEACON_MAX_INTERVAL_SEC. */
  scheduleBeacon(spec: BeaconSpec | null): void;
  /** 'tx' + TX gate: transmit one APRS status or message. Resolves true once it went out; false when refused, when
   *  the gate is closed, when the tool's budget (TOOL_TX_MIN_GAP_MS, TOOL_TX_PER_HOUR) is spent, or when the
   *  radio failed. */
  requestTx(info: string): Promise<boolean>;
  // ---- inter-tool IPC ('ipc'): the host ROUTES, it never interprets the payload ----
  emit(topic: string, data?: unknown): void; // publish to every subscriber of `topic`
  subscribe(topic: string, handler: IpcHandler): void; // receive opaque payloads on `topic`
  /** Offer a named request/response service; refused for a name another provider holds or a reserved one. */
  provideService(name: string, fn: (args: unknown) => unknown): void;
  callService(name: string, args?: unknown): unknown; // call another tool's service (undefined if none)
  /** Cooperative shared key/value scratch (LinPac vars) — no capability needed; bounded by the host. */
  store: ToolStore;
}

export interface Tool {
  manifest: ToolManifest;
  activate(ctx: ToolContext): void;
  deactivate?(): void;
}

export interface ToolHostOpts {
  /** Returns true when transmitting is currently allowed (a control-verified callsign and the operator's consent). */
  txGate?: () => boolean;
  onLog?: (tool: string, msg: string) => void;
  /** Actually transmit an info string (wired to the radio link); checked, gated and rate-limited by the host. The
   *  result (or its promise) says whether it went out. */
  transmit?: (tool: string, info: string) => boolean | void | Promise<boolean | void>;
  /** Set (a spec) or end (null) a tool's beacon schedule; checked and gated by the host. A tool switched off ends it. */
  onBeacon?: (tool: string, spec: BeaconSpec | null) => void;
  /** A tool replaced its panel or map layer: a UI showing contributions re-reads them. */
  onChange?: () => void;
  /** The clock the transmit rate limit reads; Date.now by default. */
  now?: () => number;
  /** Where the transmit budgets outlive the host (the browser tab's session storage), so a reload refills nothing. */
  txBudgetStore?: TxBudgetStore;
}

/** Each tool's transmit budget: tokens left, when they were counted, and the last transmission. */
export type TxBudgets = Record<string, { tokens: number; at: number; last?: number }>;
export interface TxBudgetStore {
  load(): unknown;
  save(budgets: TxBudgets): void;
}

/** Stored budgets, checked: a malformed entry drops, and none holds more than a full bucket. */
export function normalizeTxBudgets(raw: unknown): TxBudgets {
  const out: TxBudgets = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>).slice(0, 200)) {
    const b = v as { tokens?: unknown; at?: unknown; last?: unknown };
    if (!b || typeof b.tokens !== "number" || typeof b.at !== "number" || !Number.isFinite(b.at)) continue;
    out[k] = {
      tokens: Math.max(0, Math.min(TOOL_TX_PER_HOUR, b.tokens)),
      at: b.at,
      ...(typeof b.last === "number" && Number.isFinite(b.last) ? { last: b.last } : {}),
    };
  }
  return out;
}

/** A named bus service: its provider, and the capability a caller must hold to reach it. */
interface BusService {
  tool: string;
  /** The service; `caller` is the calling tool's name, or `(host)` for the app. */
  fn: (args: unknown, caller: string) => unknown;
  requires?: Capability;
}

/** Who calls a bus service: the name it is known by and its granted capabilities. */
interface BusCaller {
  name: string;
  has(cap: Capability): boolean;
}

/** The bus as a tool outside the host reaches it (a sandboxed import), under that tool's own name. */
export interface ToolBus {
  emit(topic: string, data?: unknown): void;
  subscribe(topic: string, handler: IpcHandler): () => void;
  call(name: string, args?: unknown): unknown;
}

interface Registered {
  tool: Tool;
  enabled: boolean;
  error?: string;
  commands: Map<string, { fn: (args: string) => string[]; remote: boolean }>;
  events: Map<ToolEvent, ((payload: ToolEventPayload) => void)[]>;
  colourisers: Colouriser[];
  decoders: Decoder[];
  panel: PanelSpec | null;
  mapLayer: MapLayerSpec | null;
  subs: string[]; // IPC topics this tool subscribed (for teardown)
  svcs: string[]; // IPC service names this tool provided (for teardown)
  beacon: boolean; // a beacon schedule is set (ended on teardown)
}

/** Why the TX gate refuses a tool. */
export const TX_CLOSED = "transmit needs a control-verified callsign and this tab's transmit consent";

export class ToolHost {
  private tools = new Map<string, Registered>();
  // Each tool's transmit budget, by name: it outlives switching the tool off or removing and installing it again.
  private txBudget = new Map<string, { tokens: number; at: number; last?: number }>();
  private vars = new Map<string, string>(); // cooperative shared store (LinPac vars); bounded below
  // Inter-tool bus. The host only ROUTES between tools; payloads are opaque to it.
  private busSubs = new Map<string, { tool: string; fn: IpcHandler }[]>(); // topic → subscribers
  private busSvcs = new Map<string, BusService>(); // name → provider
  private busDepth = 0; // re-entrancy guard so a topic loop can't run away
  private static readonly BUS_MAX_DEPTH = 16;
  constructor(private opts: ToolHostOpts = {}) {
    try {
      for (const [k, v] of Object.entries(normalizeTxBudgets(opts.txBudgetStore?.load()))) this.txBudget.set(k, v);
    } catch {
      /* no stored budgets: every tool starts with a full bucket */
    }
  }

  register(tool: Tool): void {
    if (this.tools.has(tool.manifest.name)) throw new Error(`tool ${tool.manifest.name} already registered`);
    this.tools.set(tool.manifest.name, {
      tool,
      enabled: false,
      commands: new Map(),
      events: new Map(),
      colourisers: [],
      decoders: [],
      panel: null,
      mapLayer: null,
      subs: [],
      svcs: [],
      beacon: false,
    });
  }

  /** Remove a tool: it is switched off first (its contributions and bus registrations go), then forgotten, so a
   *  tool of the same name can register again. False when no tool has that name. */
  unregister(name: string): boolean {
    if (!this.tools.has(name)) return false;
    this.setEnabled(name, false);
    this.tools.delete(name);
    return true;
  }

  /** True if a registered tool targets the given surface (its manifest `surfaces` includes it). */
  private onSurface(r: Registered, surface?: Surface): boolean {
    return surface === undefined || r.tool.manifest.surfaces.includes(surface);
  }

  list(): { manifest: ToolManifest; enabled: boolean; error?: string }[] {
    return [...this.tools.values()].map((r) => ({ manifest: r.tool.manifest, enabled: r.enabled, error: r.error }));
  }

  /** Enable/disable a tool. Enabling activates it with a capability-limited context; disabling clears it. */
  setEnabled(name: string, on: boolean): { ok: boolean; error?: string } {
    const r = this.tools.get(name);
    if (!r) return { ok: false, error: "no such tool" };
    if (on === r.enabled) return { ok: true };
    if (on) {
      this.clearContributions(r);
      r.error = undefined;
      try {
        r.tool.activate(this.contextFor(r));
        r.enabled = true;
      } catch (e) {
        r.error = (e as Error).message;
        this.clearContributions(r);
        return { ok: false, error: r.error };
      }
    } else {
      try {
        r.tool.deactivate?.();
      } catch {
        /* ignore */
      }
      this.clearContributions(r);
      r.enabled = false;
      for (const fn of this.offListeners)
        try {
          fn(name);
        } catch {
          /* a listener's failure stops nothing else */
        }
    }
    return { ok: true };
  }

  /** Reset a tool's contributions (commands/events/panels/decoders) and tear down its bus registrations. */
  private clearContributions(r: Registered): void {
    r.commands.clear();
    r.events.clear();
    r.colourisers = [];
    r.decoders = [];
    r.panel = null;
    r.mapLayer = null;
    for (const t of r.subs) {
      const l = this.busSubs.get(t);
      if (l) {
        const kept = l.filter((s) => s.tool !== r.tool.manifest.name);
        if (kept.length) this.busSubs.set(t, kept);
        else this.busSubs.delete(t);
      }
    }
    for (const n of r.svcs) {
      if (this.busSvcs.get(n)?.tool === r.tool.manifest.name) this.busSvcs.delete(n);
    }
    r.subs = [];
    r.svcs = [];
    if (r.beacon) {
      r.beacon = false;
      this.opts.onBeacon?.(r.tool.manifest.name, null);
    }
  }

  /** Dispatch an event to every enabled tool hooking it (optionally only those on `surface`). */
  dispatch(event: ToolEvent, payload: ToolEventPayload = {}, surface = payload.surface): void {
    for (const r of this.tools.values()) {
      if (!r.enabled || !this.onSurface(r, surface)) continue;
      for (const h of r.events.get(event) ?? []) {
        try {
          h(payload);
        } catch (e) {
          this.opts.onLog?.(r.tool.manifest.name, `event error: ${(e as Error).message}`);
        }
      }
    }
  }

  /**
   * Raise `on_connect` or `on_disconnect` for a connected session. Every enabled tool on the session's surface that
   * hooked the event gets the session, and, when the surface passes `send`, a `reply` of its own: up to REPLY_MAX
   * lines of REPLY_TEXT_MAX characters within REPLY_TTL_MS of the event, each sent through `send` under the tool's
   * name. A refused reply goes to the tool's log with the reason.
   */
  dispatchSession(event: "on_connect" | "on_disconnect", session: SessionInfo, send?: SessionSend): void {
    for (const r of this.tools.values()) {
      if (!r.enabled || !this.onSurface(r, session.surface)) continue;
      const handlers = r.events.get(event);
      if (!handlers?.length) continue;
      const name = r.tool.manifest.name;
      const payload: ToolEventPayload = { ...session, ...(send ? { reply: this.replyFor(name, send) } : {}) };
      for (const h of handlers) {
        try {
          h(payload);
        } catch (e) {
          this.opts.onLog?.(name, `event error: ${(e as Error).message}`);
        }
      }
    }
  }

  /** One tool's reply to one session event, held to the reply limits. */
  private replyFor(tool: string, send: SessionSend): (text: string) => void {
    const now = this.opts.now ?? Date.now;
    const until = now() + REPLY_TTL_MS;
    let left = REPLY_MAX;
    return (text) => {
      if (now() > until || left <= 0) {
        this.opts.onLog?.(tool, "reply refused: the session's reply window has closed");
        return;
      }
      const line = replyLine(text);
      if (!line.trim()) return;
      left--;
      let why: string | null;
      try {
        why = send(line, tool);
      } catch (e) {
        why = (e as Error).message;
      }
      if (why) this.opts.onLog?.(tool, `reply refused: ${why}`);
    };
  }

  /**
   * Run a registered /command (optionally scoped to `surface`); output lines, or null if none owns it.
   * `opts.remote` marks the caller as a *remote connected peer* (LinPac colon-commands D): only
   * tools whose manifest opted in with `remote: true` answer — a peer can never invoke operator-only ones.
   */
  runCommand(word: string, args = "", surface?: Surface, opts: { remote?: boolean } = {}): string[] | null {
    const w = word.toLowerCase();
    for (const r of this.tools.values()) {
      if (!r.enabled || !this.onSurface(r, surface)) continue;
      if (opts.remote && !r.tool.manifest.remote) continue; // remote peers only reach remote-allowed tools
      const h = r.commands.get(w);
      if (!h) continue;
      if (opts.remote && !h.remote) continue; // …and only the commands that opted in (operator-only ones stay local)
      try {
        return h.fn(args);
      } catch (e) {
        return [`error: ${(e as Error).message}`];
      }
    }
    return null;
  }
  commandNames(surface?: Surface): string[] {
    return [...this.tools.values()]
      .filter((r) => r.enabled && this.onSurface(r, surface))
      .flatMap((r) => [...r.commands.keys()]);
  }
  colourisers(surface?: Surface): Colouriser[] {
    return [...this.tools.values()]
      .filter((r) => r.enabled && this.onSurface(r, surface))
      .flatMap((r) => r.colourisers);
  }
  decoders(surface?: Surface): Decoder[] {
    return [...this.tools.values()].filter((r) => r.enabled && this.onSurface(r, surface)).flatMap((r) => r.decoders);
  }
  /** Enabled tools' panels for a surface: [{ tool, title, spec }] in registration order. */
  panels(surface?: Surface): { tool: string; title: string; spec: PanelSpec }[] {
    return [...this.tools.values()]
      .filter((r) => r.enabled && r.panel && this.onSurface(r, surface))
      .map((r) => ({ tool: r.tool.manifest.name, title: r.tool.manifest.title, spec: r.panel! }));
  }
  /** Enabled `map`-tools' declarative layers (the tool must target the `map` surface). */
  mapLayers(): { tool: string; spec: MapLayerSpec }[] {
    return [...this.tools.values()]
      .filter((r) => r.enabled && r.mapLayer && r.tool.manifest.surfaces.includes("map"))
      .map((r) => ({ tool: r.tool.manifest.name, spec: r.mapLayer! }));
  }

  // ---- the capability-gated context handed to a tool on activation ----
  private contextFor(r: Registered): ToolContext {
    const has = (c: Capability) => r.tool.manifest.permissions.includes(c);
    const need = (c: Capability) => {
      if (!has(c)) throw new Error(`permission '${c}' not granted to ${r.tool.manifest.name}`);
    };
    const name = r.tool.manifest.name;
    return {
      granted: has,
      log: (msg) => this.opts.onLog?.(name, msg),
      registerCommand: (word, handler, cmdOpts) => {
        need("command");
        r.commands.set(word.toLowerCase(), { fn: handler, remote: cmdOpts?.remote ?? r.tool.manifest.remote === true });
      },
      on: (event, handler) => {
        need(event === "on_frame" ? "monitor" : "event");
        (r.events.get(event) ?? r.events.set(event, []).get(event)!).push(handler);
      },
      addColouriser: (fn) => {
        need("monitor");
        r.colourisers.push(fn);
      },
      addDecoder: (d) => {
        need("decoder");
        r.decoders.push(d);
      },
      setPanel: (spec) => {
        need("panel");
        r.panel = spec;
        this.opts.onChange?.();
      },
      setMapLayer: (spec) => {
        need("map");
        r.mapLayer = spec;
        this.opts.onChange?.();
      },
      store: {
        get: (k) => this.vars.get(k),
        set: (k, val) => {
          if (this.vars.size < 200 || this.vars.has(k))
            this.vars.set(String(k).slice(0, 64), String(val).slice(0, 1024));
        },
        keys: () => [...this.vars.keys()],
      },
      scheduleBeacon: (spec) => {
        need("beacon");
        if (spec === null) {
          if (r.beacon) {
            r.beacon = false;
            this.opts.onBeacon?.(name, null);
          }
          return;
        }
        const b = normalizeBeacon(spec);
        if (typeof b === "string") throw new Error(b);
        if (!(this.opts.txGate?.() ?? false)) throw new Error(TX_CLOSED);
        r.beacon = true;
        this.opts.onBeacon?.(name, b);
      },
      requestTx: (info) => {
        need("tx");
        const why = txInfoProblem(info);
        if (why) {
          this.opts.onLog?.(name, `transmit refused: ${why}`);
          return Promise.resolve(false);
        }
        if (!(this.opts.txGate?.() ?? false)) return Promise.resolve(false);
        const held = this.takeTx(name);
        if (held) {
          this.opts.onLog?.(name, `transmit held: ${held}`);
          return Promise.resolve(false);
        }
        return Promise.resolve(this.opts.transmit?.(name, info)).then(
          (sent) => sent !== false,
          () => false,
        );
      },
      // ---- inter-tool bus: the host is a blind router; it never reads `data`/`args`/`result` ----
      emit: (topic, data) => {
        need("ipc");
        const t = this.busKey(topic);
        if (reservedTopic(t)) throw new Error(`topic "${t}" is reserved for the app`);
        this.busEmit(t, data, name);
      },
      subscribe: (topic, handler) => {
        need("ipc");
        const t = this.busKey(topic);
        (this.busSubs.get(t) ?? this.busSubs.set(t, []).get(t)!).push({ tool: name, fn: handler });
        r.subs.push(t);
      },
      provideService: (svc, fn) => {
        need("ipc");
        const n = this.busKey(svc);
        if (reserved(n)) throw new Error(`service "${n}" is reserved for the app`);
        const held = this.busSvcs.get(n);
        if (held && held.tool !== name) throw new Error(`service "${n}" is already provided by ${held.tool}`);
        this.busSvcs.set(n, { tool: name, fn: (args) => fn(args) });
        if (!r.svcs.includes(n)) r.svcs.push(n);
      },
      callService: (svc, args) => {
        need("ipc");
        return this.busCall(this.busKey(svc), args, { name, has });
      },
    };
  }

  // ---- bus internals (route-only, bounded; payloads never inspected) ----
  private busKey(s: string): string {
    const k = String(s).slice(0, 64);
    if (!k) throw new Error("empty ipc topic/service name");
    return k;
  }
  private busEmit(topic: string, data: unknown, from: string): void {
    if (this.busDepth >= ToolHost.BUS_MAX_DEPTH) {
      this.opts.onLog?.(from, `ipc: max depth on "${topic}" — dropped`);
      return;
    }
    this.busDepth++;
    try {
      for (const s of [...(this.busSubs.get(topic) ?? [])]) {
        try {
          s.fn(data, from);
        } catch (e) {
          this.opts.onLog?.(s.tool, `ipc handler error on "${topic}": ${(e as Error).message}`);
        }
      }
    } finally {
      this.busDepth--;
    }
  }
  /** Call a service. A tool caller must hold the capability the service requires; the app calls any. */
  private busCall(name: string, args: unknown, caller?: BusCaller): unknown {
    const svc = this.busSvcs.get(name);
    if (!svc) return undefined;
    if (caller && svc.requires && !caller.has(svc.requires))
      throw new Error(`service "${name}" needs the '${svc.requires}' permission, which ${caller.name} does not hold`);
    if (this.busDepth >= ToolHost.BUS_MAX_DEPTH) {
      this.opts.onLog?.(svc.tool, `ipc: max depth calling "${name}"`);
      return undefined;
    }
    this.busDepth++;
    try {
      return svc.fn(args, caller?.name ?? ToolHost.HOST);
    } catch (e) {
      this.opts.onLog?.(svc.tool, `ipc service "${name}" error: ${(e as Error).message}`);
      return undefined;
    } finally {
      this.busDepth--;
    }
  }

  /**
   * Take one transmission from a tool's budget: at most one per TOOL_TX_MIN_GAP_MS, and TOOL_TX_PER_HOUR an hour
   * sustained (a bucket that refills over the hour). Requests, beacons and session scripts all draw on it; `count`
   * takes several transmissions at once (a script's connects and sends). Null when the tool may transmit now, else
   * why it is held.
   */
  takeTx(tool: string, count = 1): string | null {
    const now = (this.opts.now ?? Date.now)();
    const b = this.txBudget.get(tool) ?? { tokens: TOOL_TX_PER_HOUR, at: now };
    b.tokens = Math.min(TOOL_TX_PER_HOUR, b.tokens + ((now - b.at) / 3_600_000) * TOOL_TX_PER_HOUR);
    b.at = now;
    this.txBudget.set(tool, b);
    if (b.last !== undefined && now - b.last < TOOL_TX_MIN_GAP_MS)
      return `one transmission per ${TOOL_TX_MIN_GAP_MS / 1000} s`;
    if (b.tokens < count) return `at most ${TOOL_TX_PER_HOUR} transmissions an hour`;
    b.tokens -= count;
    b.last = now;
    try {
      this.opts.txBudgetStore?.save(Object.fromEntries(this.txBudget));
    } catch {
      /* storage blocked: the budget holds for this page */
    }
    return null;
  }

  private offListeners = new Set<(tool: string) => void>();
  /** Call `fn` with a tool's name whenever it is switched off or removed; returns the disposer. */
  onToolOff(fn: (tool: string) => void): () => void {
    this.offListeners.add(fn);
    return () => this.offListeners.delete(fn);
  }

  /** End a tool's beacon from the host's side (the consent or the callsign it was set under is gone). */
  endBeacon(name: string, why: string): void {
    const r = this.tools.get(name);
    if (!r?.beacon) return;
    r.beacon = false;
    this.opts.onBeacon?.(name, null);
    this.opts.onLog?.(name, `beacon ended: ${why}`);
  }

  /** The tools whose beacon is set. */
  beaconTools(): string[] {
    return [...this.tools.values()].filter((r) => r.beacon).map((r) => r.tool.manifest.name);
  }

  /** Introspection for the Tools console: currently-live bus topics + service names. */
  ipcTopics(): string[] {
    return [...this.busSubs.keys()].filter((t) => (this.busSubs.get(t)?.length ?? 0) > 0).sort();
  }
  ipcServices(): string[] {
    return [...this.busSvcs.keys()].sort();
  }

  // ---- surface participation on the bus: the trusted app (a surface like the packet
  // terminal) may offer a SERVICE to tools and PUBLISH to them — GPRI's model where GP the host exposed
  // getQsoData/transmit to plugins. Still route-only: the host never interprets the payload. Not
  // capability-gated for the app itself (the app is trusted, and publishes as `(host)`); a service it
  // offers may still require a capability of the tools that call it. Each registration returns a
  // disposer for teardown. ----
  private static readonly HOST = "(host)";
  /**
   * Offer a service from the app. `requires` names the capability a calling tool must hold: a service that
   * makes the radio transmit requires `tx`, so a tool granted only `ipc` cannot key the transmitter.
   */
  registerHostService(
    name: string,
    fn: (args: unknown, caller: string) => unknown,
    opts: { requires?: Capability } = {},
  ): () => void {
    const n = this.busKey(name);
    const entry: BusService = { tool: ToolHost.HOST, fn, requires: opts.requires };
    this.busSvcs.set(n, entry);
    return () => {
      if (this.busSvcs.get(n) === entry) this.busSvcs.delete(n);
    };
  }
  hostEmit(topic: string, data?: unknown): void {
    this.busEmit(this.busKey(topic), data, ToolHost.HOST);
  }
  /** Listen on a topic from the app (a request tools publish, such as `link.ping.request`); returns the disposer. */
  hostSubscribe(topic: string, fn: IpcHandler): () => void {
    return this.addSub(this.busKey(topic), ToolHost.HOST, fn);
  }

  /**
   * The bus for a tool that runs outside the host (a sandboxed import), under the tool's manifest name:
   * subscribers see that name as the sender, never the app's `(host)`, and a service checks `permissions`
   * (the tool's granted capabilities) exactly as it does for an in-process tool.
   */
  toolBus(name: string, permissions: readonly Capability[]): ToolBus {
    const caller: BusCaller = { name, has: (c) => permissions.includes(c) };
    return {
      emit: (topic, data) => {
        const t = this.busKey(topic);
        if (reservedTopic(t)) throw new Error(`topic "${t}" is reserved for the app`);
        this.busEmit(t, data, name);
      },
      subscribe: (topic, handler) => this.addSub(this.busKey(topic), name, handler),
      call: (svc, args) => this.busCall(this.busKey(svc), args, caller),
    };
  }

  private addSub(t: string, tool: string, fn: IpcHandler): () => void {
    const entry = { tool, fn };
    (this.busSubs.get(t) ?? this.busSubs.set(t, []).get(t)!).push(entry);
    return () => {
      const l = this.busSubs.get(t);
      if (l) {
        const k = l.filter((s) => s !== entry);
        if (k.length) this.busSubs.set(t, k);
        else this.busSubs.delete(t);
      }
    };
  }
}
