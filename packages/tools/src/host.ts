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

/** The shortest gap between two transmissions one tool asks for with `requestTx`. */
export const TOOL_TX_MIN_GAP_MS = 60_000;
/** The shortest beacon interval a tool may schedule: ten minutes, the usual floor for a fixed APRS station. */
export const BEACON_MIN_INTERVAL_SEC = 600;
/** The longest beacon interval: one day. */
export const BEACON_MAX_INTERVAL_SEC = 86_400;
/** The longest APRS information field a tool may transmit. */
export const TX_INFO_MAX = 256;
/** The longest beacon comment: an APRS status text holds 62 characters. */
export const BEACON_COMMENT_MAX = 62;

/**
 * Why an APRS information field a tool asks to transmit is refused, or null when it may go out. One line of text,
 * not empty, at most TX_INFO_MAX characters, and never third-party traffic (`}`), which would carry another
 * station's callsign as its source.
 */
export function txInfoProblem(info: unknown): string | null {
  if (typeof info !== "string") return "the frame must be text";
  if (!info.trim()) return "the frame is empty";
  if (info.length > TX_INFO_MAX) return `the frame is longer than ${TX_INFO_MAX} characters`;
  if (/[\r\n\0]/.test(info)) return "the frame must be one line";
  if (info.startsWith("}")) return "a tool may not send third-party traffic";
  return null;
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
  reply?: (text: string) => void; // send a line back on this channel (PMS/auto-answer)
  [k: string]: unknown;
}

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
  /** 'tx' + TX gate: transmit one APRS information field. False when refused, when the gate is closed, or when the
   *  tool transmitted less than TOOL_TX_MIN_GAP_MS ago. */
  requestTx(info: string): boolean;
  // ---- inter-tool IPC ('ipc'): the host ROUTES, it never interprets the payload ----
  emit(topic: string, data?: unknown): void; // publish to every subscriber of `topic`
  subscribe(topic: string, handler: IpcHandler): void; // receive opaque payloads on `topic`
  provideService(name: string, fn: (args: unknown) => unknown): void; // offer a named request/response service
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
  /** Actually transmit an info string (wired to the radio link); checked, gated and rate-limited by the host. */
  transmit?: (tool: string, info: string) => void;
  /** Set (a spec) or end (null) a tool's beacon schedule; checked and gated by the host. A tool switched off ends it. */
  onBeacon?: (tool: string, spec: BeaconSpec | null) => void;
  /** A tool replaced its panel or map layer: a UI showing contributions re-reads them. */
  onChange?: () => void;
  /** The clock the transmit rate limit reads; Date.now by default. */
  now?: () => number;
}

/** A named bus service: its provider, and the capability a caller must hold to reach it. */
interface BusService {
  tool: string;
  fn: (args: unknown) => unknown;
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
  lastTx?: number; // when the tool last transmitted (the rate limit)
}

/** Why the TX gate refuses a tool. */
export const TX_CLOSED = "transmit needs a control-verified callsign and this tab's transmit consent";

export class ToolHost {
  private tools = new Map<string, Registered>();
  private vars = new Map<string, string>(); // cooperative shared store (LinPac vars); bounded below
  // Inter-tool bus. The host only ROUTES between tools; payloads are opaque to it.
  private busSubs = new Map<string, { tool: string; fn: IpcHandler }[]>(); // topic → subscribers
  private busSvcs = new Map<string, BusService>(); // name → provider
  private busDepth = 0; // re-entrancy guard so a topic loop can't run away
  private static readonly BUS_MAX_DEPTH = 16;
  constructor(private opts: ToolHostOpts = {}) {}

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
          return false;
        }
        if (!(this.opts.txGate?.() ?? false)) return false;
        const now = (this.opts.now ?? Date.now)();
        if (r.lastTx !== undefined && now - r.lastTx < TOOL_TX_MIN_GAP_MS) {
          this.opts.onLog?.(name, `transmit held: one transmission per ${TOOL_TX_MIN_GAP_MS / 1000} s`);
          return false;
        }
        r.lastTx = now;
        this.opts.transmit?.(name, info);
        return true;
      },
      // ---- inter-tool bus: the host is a blind router; it never reads `data`/`args`/`result` ----
      emit: (topic, data) => {
        need("ipc");
        this.busEmit(this.busKey(topic), data, name);
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
        this.busSvcs.set(n, { tool: name, fn });
        r.svcs.push(n);
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
      return svc.fn(args);
    } catch (e) {
      this.opts.onLog?.(svc.tool, `ipc service "${name}" error: ${(e as Error).message}`);
      return undefined;
    } finally {
      this.busDepth--;
    }
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
  registerHostService(name: string, fn: (args: unknown) => unknown, opts: { requires?: Capability } = {}): () => void {
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

  /**
   * The bus for a tool that runs outside the host (a sandboxed import), under the tool's manifest name:
   * subscribers see that name as the sender, never the app's `(host)`, and a service checks `permissions`
   * (the tool's granted capabilities) exactly as it does for an in-process tool.
   */
  toolBus(name: string, permissions: readonly Capability[]): ToolBus {
    const caller: BusCaller = { name, has: (c) => permissions.includes(c) };
    return {
      emit: (topic, data) => this.busEmit(this.busKey(topic), data, name),
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
