// SPDX-License-Identifier: MIT
/**
 * host.ts — the Tool host (docs/27 B.3). Registers tools, activates enabled ones with a capability-
 * limited ToolContext, dispatches events, and collects their contributions (commands, monitor
 * colourisers, decoders). Every context method enforces the tool's granted capabilities; the gated
 * 'tx'/'beacon' surfaces additionally pass an injected TX gate (the H5 / control-verification check) at
 * call time — a Tool can never transmit without it, and never touches verify.ts trust.
 *
 * INVARIANT (docs/28 §5f): the host ROUTES, it never interprets. Every method here is a generic verb
 * (register / on / emit / subscribe / store / panel / tx-gate) — none is named after a domain function.
 * All tool BEHAVIOUR lives in builtins/ or imported tools; cross-tool cooperation happens only over the
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

export interface MonitorColour { colorVar?: string; hidden?: boolean }
export type Colouriser = (line: { src: string; dst: string; text: string }) => MonitorColour | null;
export interface Decoder { id: string; label: string; kind: string; decode(input: string): string }
export interface BeaconSpec { comment: string; intervalSec: number }

/**
 * The context an event carries (docs/28 A — LinPac's channel/station model). Every field is optional so
 * a caller supplies what its surface knows; a connected-mode surface fills peerCall/myCall/channel and a
 * `reply` sink, and looks the peer up in the station registry for `station`.
 */
export interface ToolEventPayload {
  surface?: Surface;
  channel?: number;
  peerCall?: string;                       // the far station (GP {chan}); on_frame → the heard callsign
  myCall?: string;                         // the local station in use
  source?: string;                         // on_frame provenance label — "RF" (terminal/TNC), "APRS", …
  station?: { roles?: string[]; [k: string]: unknown } | null; // per-callsign context (account_stations)
  reply?: (text: string) => void;          // send a line back on this channel (PMS/auto-answer)
  [k: string]: unknown;
}

/** A cooperative per-host string store (LinPac lp_set_var/get_var) shared by enabled tools. */
export interface ToolStore { get(key: string): string | undefined; set(key: string, value: string): void; keys(): string[] }

/** An inter-tool bus subscriber: receives an opaque payload + the emitting tool's name. */
export type IpcHandler = (data: unknown, from: string) => void;

/** The host-API surface a tool receives on activation — every method is capability-gated. */
export interface ToolContext {
  granted(cap: Capability): boolean;
  log(msg: string): void;
  /** Register a /word. In a `remote:true` tool, pass `{ remote: false }` to keep this command operator-only. */
  registerCommand(word: string, handler: (args: string) => string[], opts?: { remote?: boolean }): void;   // 'command'
  on(event: ToolEvent, handler: (payload: ToolEventPayload) => void): void;    // 'event' (on_frame → 'monitor')
  addColouriser(fn: Colouriser): void;                                        // 'monitor'
  addDecoder(d: Decoder): void;                                               // 'decoder'
  setPanel(spec: PanelSpec | null): void;                                     // 'panel' — declarative UI region
  setMapLayer(spec: MapLayerSpec | null): void;                               // 'map' — declarative marker layer
  scheduleBeacon(spec: BeaconSpec): void;                                     // 'beacon' + TX gate
  requestTx(info: string): boolean;                                          // 'tx' + TX gate; false if denied
  // ---- inter-tool IPC ('ipc'): the host ROUTES, it never interprets the payload (docs/28 §5f) ----
  emit(topic: string, data?: unknown): void;                                  // publish to every subscriber of `topic`
  subscribe(topic: string, handler: IpcHandler): void;                        // receive opaque payloads on `topic`
  provideService(name: string, fn: (args: unknown) => unknown): void;         // offer a named request/response service
  callService(name: string, args?: unknown): unknown;                         // call another tool's service (undefined if none)
  /** Cooperative shared key/value scratch (LinPac vars) — no capability needed; bounded by the host. */
  store: ToolStore;
}

export interface Tool {
  manifest: ToolManifest;
  activate(ctx: ToolContext): void;
  deactivate?(): void;
}

export interface ToolHostOpts {
  /** Returns true when transmitting is currently allowed (verified callsign + opt-in, H5). */
  txGate?: () => boolean;
  onLog?: (tool: string, msg: string) => void;
  /** Actually transmit an info string (wired to the RF/announce path); gated by the host already. */
  transmit?: (tool: string, info: string) => void;
  /** Register a beacon schedule (wired to the beacon scheduler); gated by the host already. */
  onBeacon?: (tool: string, spec: BeaconSpec) => void;
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
  subs: string[];   // IPC topics this tool subscribed (for teardown)
  svcs: string[];   // IPC service names this tool provided (for teardown)
}

export class ToolHost {
  private tools = new Map<string, Registered>();
  private vars = new Map<string, string>();   // cooperative shared store (LinPac vars); bounded below
  // Inter-tool bus (docs/28 §5f). The host only ROUTES between tools; payloads are opaque to it.
  private busSubs = new Map<string, { tool: string; fn: IpcHandler }[]>();   // topic → subscribers
  private busSvcs = new Map<string, { tool: string; fn: (args: unknown) => unknown }>(); // name → provider
  private busDepth = 0;                          // re-entrancy guard so a topic loop can't run away
  private static readonly BUS_MAX_DEPTH = 16;
  constructor(private opts: ToolHostOpts = {}) {}

  register(tool: Tool): void {
    if (this.tools.has(tool.manifest.name)) throw new Error(`tool ${tool.manifest.name} already registered`);
    this.tools.set(tool.manifest.name, { tool, enabled: false, commands: new Map(), events: new Map(), colourisers: [], decoders: [], panel: null, mapLayer: null, subs: [], svcs: [] });
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
      this.clearContributions(r); r.error = undefined;
      try { r.tool.activate(this.contextFor(r)); r.enabled = true; }
      catch (e) { r.error = (e as Error).message; this.clearContributions(r); return { ok: false, error: r.error }; }
    } else {
      try { r.tool.deactivate?.(); } catch { /* ignore */ }
      this.clearContributions(r); r.enabled = false;
    }
    return { ok: true };
  }

  /** Reset a tool's contributions (commands/events/panels/decoders) and tear down its bus registrations. */
  private clearContributions(r: Registered): void {
    r.commands.clear(); r.events.clear(); r.colourisers = []; r.decoders = []; r.panel = null; r.mapLayer = null;
    for (const t of r.subs) { const l = this.busSubs.get(t); if (l) { const kept = l.filter((s) => s.tool !== r.tool.manifest.name); kept.length ? this.busSubs.set(t, kept) : this.busSubs.delete(t); } }
    for (const n of r.svcs) { if (this.busSvcs.get(n)?.tool === r.tool.manifest.name) this.busSvcs.delete(n); }
    r.subs = []; r.svcs = [];
  }

  /** Dispatch an event to every enabled tool hooking it (optionally only those on `surface`). */
  dispatch(event: ToolEvent, payload: ToolEventPayload = {}, surface = payload.surface): void {
    for (const r of this.tools.values()) {
      if (!r.enabled || !this.onSurface(r, surface)) continue;
      for (const h of r.events.get(event) ?? []) { try { h(payload); } catch (e) { this.opts.onLog?.(r.tool.manifest.name, `event error: ${(e as Error).message}`); } }
    }
  }

  /**
   * Run a registered /command (optionally scoped to `surface`); output lines, or null if none owns it.
   * `opts.remote` marks the caller as a *remote connected peer* (LinPac colon-commands, docs/28 D): only
   * tools whose manifest opted in with `remote: true` answer — a peer can never invoke operator-only ones.
   */
  runCommand(word: string, args = "", surface?: Surface, opts: { remote?: boolean } = {}): string[] | null {
    const w = word.toLowerCase();
    for (const r of this.tools.values()) {
      if (!r.enabled || !this.onSurface(r, surface)) continue;
      if (opts.remote && !r.tool.manifest.remote) continue;   // remote peers only reach remote-allowed tools
      const h = r.commands.get(w);
      if (!h) continue;
      if (opts.remote && !h.remote) continue;                 // …and only the commands that opted in (operator-only ones stay local)
      try { return h.fn(args); } catch (e) { return [`error: ${(e as Error).message}`]; }
    }
    return null;
  }
  commandNames(surface?: Surface): string[] { return [...this.tools.values()].filter((r) => r.enabled && this.onSurface(r, surface)).flatMap((r) => [...r.commands.keys()]); }
  colourisers(surface?: Surface): Colouriser[] { return [...this.tools.values()].filter((r) => r.enabled && this.onSurface(r, surface)).flatMap((r) => r.colourisers); }
  decoders(surface?: Surface): Decoder[] { return [...this.tools.values()].filter((r) => r.enabled && this.onSurface(r, surface)).flatMap((r) => r.decoders); }
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
    const need = (c: Capability) => { if (!has(c)) throw new Error(`permission '${c}' not granted to ${r.tool.manifest.name}`); };
    const name = r.tool.manifest.name;
    return {
      granted: has,
      log: (msg) => this.opts.onLog?.(name, msg),
      registerCommand: (word, handler, cmdOpts) => { need("command"); r.commands.set(word.toLowerCase(), { fn: handler, remote: cmdOpts?.remote ?? (r.tool.manifest.remote === true) }); },
      on: (event, handler) => { need(event === "on_frame" ? "monitor" : "event"); (r.events.get(event) ?? r.events.set(event, []).get(event)!).push(handler); },
      addColouriser: (fn) => { need("monitor"); r.colourisers.push(fn); },
      addDecoder: (d) => { need("decoder"); r.decoders.push(d); },
      setPanel: (spec) => { need("panel"); r.panel = spec; },
      setMapLayer: (spec) => { need("map"); r.mapLayer = spec; },
      store: {
        get: (k) => this.vars.get(k),
        set: (k, val) => { if (this.vars.size < 200 || this.vars.has(k)) this.vars.set(String(k).slice(0, 64), String(val).slice(0, 1024)); },
        keys: () => [...this.vars.keys()],
      },
      scheduleBeacon: (spec) => { need("beacon"); if (!(this.opts.txGate?.() ?? false)) throw new Error("TX gate closed (verify callsign + opt-in)"); this.opts.onBeacon?.(name, spec); },
      requestTx: (info) => { need("tx"); if (!(this.opts.txGate?.() ?? false)) return false; this.opts.transmit?.(name, info); return true; },
      // ---- inter-tool bus: the host is a blind router; it never reads `data`/`args`/`result` ----
      emit: (topic, data) => { need("ipc"); this.busEmit(this.busKey(topic), data, name); },
      subscribe: (topic, handler) => { need("ipc"); const t = this.busKey(topic); (this.busSubs.get(t) ?? this.busSubs.set(t, []).get(t)!).push({ tool: name, fn: handler }); r.subs.push(t); },
      provideService: (svc, fn) => { need("ipc"); const n = this.busKey(svc); this.busSvcs.set(n, { tool: name, fn }); r.svcs.push(n); },
      callService: (svc, args) => { need("ipc"); return this.busCall(this.busKey(svc), args); },
    };
  }

  // ---- bus internals (route-only, bounded; payloads never inspected) ----
  private busKey(s: string): string { const k = String(s).slice(0, 64); if (!k) throw new Error("empty ipc topic/service name"); return k; }
  private busEmit(topic: string, data: unknown, from: string): void {
    if (this.busDepth >= ToolHost.BUS_MAX_DEPTH) { this.opts.onLog?.(from, `ipc: max depth on "${topic}" — dropped`); return; }
    this.busDepth++;
    try { for (const s of [...(this.busSubs.get(topic) ?? [])]) { try { s.fn(data, from); } catch (e) { this.opts.onLog?.(s.tool, `ipc handler error on "${topic}": ${(e as Error).message}`); } } }
    finally { this.busDepth--; }
  }
  private busCall(name: string, args: unknown): unknown {
    const svc = this.busSvcs.get(name);
    if (!svc) return undefined;
    if (this.busDepth >= ToolHost.BUS_MAX_DEPTH) { this.opts.onLog?.(svc.tool, `ipc: max depth calling "${name}"`); return undefined; }
    this.busDepth++;
    try { return svc.fn(args); } catch (e) { this.opts.onLog?.(svc.tool, `ipc service "${name}" error: ${(e as Error).message}`); return undefined; }
    finally { this.busDepth--; }
  }

  /** Introspection for the Tools console: currently-live bus topics + service names (docs/28). */
  ipcTopics(): string[] { return [...this.busSubs.keys()].filter((t) => (this.busSubs.get(t)?.length ?? 0) > 0).sort(); }
  ipcServices(): string[] { return [...this.busSvcs.keys()].sort(); }

  // ---- surface participation on the bus (docs/28 §5f): the trusted app (a surface like the packet
  // terminal) may offer a SERVICE to tools and PUBLISH to them — GPRI's model where GP the host exposed
  // getQsoData/transmit to plugins. Still route-only: the host never interprets the payload. Not
  // capability-gated (the app is trusted); each registration returns a disposer for teardown. ----
  private static readonly HOST = "(host)";
  registerHostService(name: string, fn: (args: unknown) => unknown): () => void {
    const n = this.busKey(name); this.busSvcs.set(n, { tool: ToolHost.HOST, fn });
    return () => { if (this.busSvcs.get(n)?.tool === ToolHost.HOST) this.busSvcs.delete(n); };
  }
  hostEmit(topic: string, data?: unknown): void { this.busEmit(this.busKey(topic), data, ToolHost.HOST); }
  hostCallService(name: string, args?: unknown): unknown { return this.busCall(this.busKey(name), args); }
  hostSubscribe(topic: string, handler: IpcHandler): () => void {
    const t = this.busKey(topic); const entry = { tool: ToolHost.HOST, fn: handler };
    (this.busSubs.get(t) ?? this.busSubs.set(t, []).get(t)!).push(entry);
    return () => { const l = this.busSubs.get(t); if (l) { const k = l.filter((s) => s !== entry); k.length ? this.busSubs.set(t, k) : this.busSubs.delete(t); } };
  }
}
