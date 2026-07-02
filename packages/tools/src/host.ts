/**
 * host.ts — the Tool host (docs/27 B.3). Registers tools, activates enabled ones with a capability-
 * limited ToolContext, dispatches events, and collects their contributions (commands, monitor
 * colourisers, decoders). Every context method enforces the tool's granted capabilities; the gated
 * 'tx'/'beacon' surfaces additionally pass an injected TX gate (the H5 / control-verification check) at
 * call time — a Tool can never transmit without it, and never touches verify.ts trust.
 */
import type { Capability } from "./capabilities.js";
import type { ToolManifest } from "./manifest.js";
import type { Surface } from "./surfaces.js";
import type { PanelSpec } from "./panel.js";

/** Lifecycle/monitor events a tool can hook. on_frame carries a heard frame; others are payload-shaped. */
export type ToolEvent = "on_frame" | "on_connect" | "on_disconnect" | "on_beacon" | "on_find" | "on_spot";

export interface MonitorColour { colorVar?: string; hidden?: boolean }
export type Colouriser = (line: { src: string; dst: string; text: string }) => MonitorColour | null;
export interface Decoder { id: string; label: string; kind: string; decode(input: string): string }
export interface BeaconSpec { comment: string; intervalSec: number }

/** The host-API surface a tool receives on activation — every method is capability-gated. */
export interface ToolContext {
  granted(cap: Capability): boolean;
  log(msg: string): void;
  registerCommand(word: string, handler: (args: string) => string[]): void;   // 'command'
  on(event: ToolEvent, handler: (payload: unknown) => void): void;            // 'event' (on_frame → 'monitor')
  addColouriser(fn: Colouriser): void;                                        // 'monitor'
  addDecoder(d: Decoder): void;                                               // 'decoder'
  setPanel(spec: PanelSpec | null): void;                                     // 'panel' — declarative UI region
  scheduleBeacon(spec: BeaconSpec): void;                                     // 'beacon' + TX gate
  requestTx(info: string): boolean;                                          // 'tx' + TX gate; false if denied
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
  commands: Map<string, (args: string) => string[]>;
  events: Map<ToolEvent, ((payload: unknown) => void)[]>;
  colourisers: Colouriser[];
  decoders: Decoder[];
  panel: PanelSpec | null;
}

export class ToolHost {
  private tools = new Map<string, Registered>();
  constructor(private opts: ToolHostOpts = {}) {}

  register(tool: Tool): void {
    if (this.tools.has(tool.manifest.name)) throw new Error(`tool ${tool.manifest.name} already registered`);
    this.tools.set(tool.manifest.name, { tool, enabled: false, commands: new Map(), events: new Map(), colourisers: [], decoders: [], panel: null });
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
      r.commands.clear(); r.events.clear(); r.colourisers = []; r.decoders = []; r.panel = null; r.error = undefined;
      try { r.tool.activate(this.contextFor(r)); r.enabled = true; }
      catch (e) { r.error = (e as Error).message; r.commands.clear(); r.events.clear(); r.colourisers = []; r.decoders = []; r.panel = null; return { ok: false, error: r.error }; }
    } else {
      try { r.tool.deactivate?.(); } catch { /* ignore */ }
      r.commands.clear(); r.events.clear(); r.colourisers = []; r.decoders = []; r.panel = null; r.enabled = false;
    }
    return { ok: true };
  }

  /** Dispatch an event to every enabled tool hooking it (optionally only those on `surface`). */
  dispatch(event: ToolEvent, payload: unknown, surface?: Surface): void {
    for (const r of this.tools.values()) {
      if (!r.enabled || !this.onSurface(r, surface)) continue;
      for (const h of r.events.get(event) ?? []) { try { h(payload); } catch (e) { this.opts.onLog?.(r.tool.manifest.name, `event error: ${(e as Error).message}`); } }
    }
  }

  /** Run a registered /command (optionally scoped to `surface`); output lines, or null if none owns it. */
  runCommand(word: string, args = "", surface?: Surface): string[] | null {
    const w = word.toLowerCase();
    for (const r of this.tools.values()) {
      if (!r.enabled || !this.onSurface(r, surface)) continue;
      const h = r.commands.get(w);
      if (h) { try { return h(args); } catch (e) { return [`error: ${(e as Error).message}`]; } }
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

  // ---- the capability-gated context handed to a tool on activation ----
  private contextFor(r: Registered): ToolContext {
    const has = (c: Capability) => r.tool.manifest.permissions.includes(c);
    const need = (c: Capability) => { if (!has(c)) throw new Error(`permission '${c}' not granted to ${r.tool.manifest.name}`); };
    const name = r.tool.manifest.name;
    return {
      granted: has,
      log: (msg) => this.opts.onLog?.(name, msg),
      registerCommand: (word, handler) => { need("command"); r.commands.set(word.toLowerCase(), handler); },
      on: (event, handler) => { need(event === "on_frame" ? "monitor" : "event"); (r.events.get(event) ?? r.events.set(event, []).get(event)!).push(handler); },
      addColouriser: (fn) => { need("monitor"); r.colourisers.push(fn); },
      addDecoder: (d) => { need("decoder"); r.decoders.push(d); },
      setPanel: (spec) => { need("panel"); r.panel = spec; },
      scheduleBeacon: (spec) => { need("beacon"); if (!(this.opts.txGate?.() ?? false)) throw new Error("TX gate closed (verify callsign + opt-in)"); this.opts.onBeacon?.(name, spec); },
      requestTx: (info) => { need("tx"); if (!(this.opts.txGate?.() ?? false)) return false; this.opts.transmit?.(name, info); return true; },
    };
  }
}
