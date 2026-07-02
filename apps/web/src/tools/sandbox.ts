// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * sandbox.ts — the Web Worker sandbox for IMPORTED (third-party) Tools (docs/design/27 B.3 / docs/design/28 §6). Built-in
 * tools run in-process (trusted); an imported tool's script runs in a Worker with the dangerous globals
 * (fetch/XHR/WebSocket/importScripts) shadowed unless it was granted 'network'. The worker exposes a
 * `register({ commands, colourRules, panel, decoders })` API + an `ipc` bridge, and answers command/decode
 * calls over postMessage. Contributions reach every surface the same way built-ins do: the host adapter
 * (ToolsPanel) wires the DECLARATIVE ones (colour rules, panel) into the shared ToolHost synchronously,
 * while code-bearing ones (commands, decoders) round-trip to the worker asynchronously. This is the
 * untrusted-code boundary; Chromium-first, sandbox hardening is validate-at-deploy.
 */
import { validateManifest, type ToolManifest, type Capability } from "@aprsweb/tools";

export async function fetchToolManifest(url: string): Promise<{ ok: true; manifest: ToolManifest; base: string } | { ok: false; error: string }> {
  try {
    const res = await fetch(url, { credentials: "omit" });
    if (!res.ok) return { ok: false, error: `manifest ${res.status}` };
    const v = validateManifest(await res.json());
    if (!v.ok) return v;
    return { ok: true, manifest: v.manifest, base: new URL(url, location.href).href };
  } catch (e) { return { ok: false, error: (e as Error).message }; }
}

/** The bus bridge the host provides to an imported tool (only wired when it was granted 'ipc'). */
export interface IpcBridge {
  emit(topic: string, data: unknown): void;
  subscribe(topic: string, cb: (data: unknown, from: string) => void): () => void;
  call(name: string, args: unknown): unknown;
}

/** A declarative monitor colour rule — evaluated host-side (sync), so no per-line Worker round-trip. */
export interface ColourRule { srcPrefix?: string; dstPrefix?: string; textIncludes?: string; colorVar?: string; hidden?: boolean }
/** Decoder metadata an imported tool contributes; the decode itself runs in the worker (async). */
export interface DecoderMeta { id: string; label: string; kind: string }

/** The worker bootstrap (stringified) — locks down globals, evals the tool, bridges commands/decode/IPC. */
function workerSource(): string {
  return `
    let commands = {}, colourRules = [], panel = null, decoderFns = {}, decoderMeta = [];
    const subs = {}; const pendingCalls = {}; let callSeq = 0;
    const ipc = {
      emit: (topic, data) => self.postMessage({ type: "emit", topic, data }),
      subscribe: (topic, cb) => { (subs[topic] = subs[topic] || []).push(cb); self.postMessage({ type: "subscribe", topic }); },
      call: (name, args) => new Promise((res) => { const id = ++callSeq; pendingCalls[id] = res; self.postMessage({ type: "call", id, name, args }); }),
      setPanel: (spec) => { panel = spec; self.postMessage({ type: "panel", spec }); },
    };
    const register = (t) => {
      commands = (t && t.commands) || {};
      colourRules = Array.isArray(t && t.colourRules) ? t.colourRules.slice(0, 40) : [];
      panel = (t && t.panel) || null;
      decoderFns = {}; decoderMeta = [];
      for (const d of (t && t.decoders) || []) if (d && d.id && typeof d.decode === "function") { decoderFns[d.id] = d.decode; decoderMeta.push({ id: String(d.id), label: String(d.label || d.id), kind: String(d.kind || d.id) }); }
    };
    self.onmessage = (ev) => {
      const m = ev.data;
      if (m.type === "load") {
        if (!m.network) { for (const g of ["fetch","XMLHttpRequest","WebSocket","importScripts"]) { try { self[g] = undefined; } catch (e) {} } }
        try { new Function("register", "ipc", m.script)(register, m.ipc ? ipc : undefined);
          self.postMessage({ type: "loaded", commands: Object.keys(commands), colourRules, panel, decoders: decoderMeta }); }
        catch (e) { self.postMessage({ type: "error", error: String(e && e.message || e) }); }
      } else if (m.type === "cmd") {
        try { const r = commands[m.word]; const out = r ? r(m.args) : ["no such command"]; self.postMessage({ type: "cmdResult", id: m.id, lines: [].concat(out).map(String) }); }
        catch (e) { self.postMessage({ type: "cmdResult", id: m.id, lines: ["error: " + (e && e.message || e)] }); }
      } else if (m.type === "decode") {
        try { const fn = decoderFns[m.decId]; self.postMessage({ type: "decodeResult", id: m.id, out: fn ? String(fn(String(m.input))) : "no such decoder" }); }
        catch (e) { self.postMessage({ type: "decodeResult", id: m.id, out: "error: " + (e && e.message || e) }); }
      } else if (m.type === "ipcEvent") {
        for (const cb of subs[m.topic] || []) { try { cb(m.data, m.from); } catch (e) {} }
      } else if (m.type === "callResult") {
        const res = pendingCalls[m.id]; if (res) { delete pendingCalls[m.id]; res(m.result); }
      }
    };`;
}

export interface Sandbox {
  commands: string[];
  colourRules: ColourRule[];
  panel: unknown | null;                 // initial declarative PanelSpec (sanitised by the host adapter)
  decoders: DecoderMeta[];
  runCommand(word: string, args: string): Promise<string[]>;
  decode(id: string, input: string): Promise<string>;
  onPanel(cb: (spec: unknown) => void): void;   // dynamic panel updates (ipc.setPanel from the worker)
  destroy(): void;
}

/**
 * Load a tool script into a locked-down worker. `granted` are the user-approved capabilities; `bridge`
 * (supplied only when 'ipc' was granted) wires the worker's emit/subscribe/call to the host bus.
 */
export async function loadSandbox(scriptUrl: string, granted: Capability[], bridge?: IpcBridge): Promise<Sandbox> {
  const script = await (await fetch(scriptUrl, { credentials: "omit" })).text();
  const worker = new Worker(URL.createObjectURL(new Blob([workerSource()], { type: "text/javascript" })));
  const ipcOn = granted.includes("ipc") && !!bridge;
  const disposers: Array<() => void> = [];
  let panelCb: ((spec: unknown) => void) | null = null;
  const decodePending = new Map<number, (out: string) => void>();
  let dseq = 0;

  // Bridge worker → host (IPC + dynamic panel updates + decode results). The host routes; payloads opaque.
  const onAux = (ev: MessageEvent) => {
    const m = ev.data;
    if (m.type === "panel") { panelCb?.(m.spec); return; }
    if (m.type === "decodeResult") { decodePending.get(m.id)?.(m.out); decodePending.delete(m.id); return; }
    if (!ipcOn || !bridge) return;
    if (m.type === "emit") bridge.emit(String(m.topic), m.data);
    else if (m.type === "subscribe") disposers.push(bridge.subscribe(String(m.topic), (data, from) => worker.postMessage({ type: "ipcEvent", topic: m.topic, data, from })));
    else if (m.type === "call") worker.postMessage({ type: "callResult", id: m.id, result: bridge.call(String(m.name), m.args) });
  };

  const loaded = await new Promise<{ commands: string[]; colourRules: ColourRule[]; panel: unknown | null; decoders: DecoderMeta[] }>((resolve, reject) => {
    worker.onmessage = (ev) => {
      if (ev.data.type === "loaded") resolve(ev.data);
      else if (ev.data.type === "error") reject(new Error(ev.data.error));
      else onAux(ev);
    };
    worker.postMessage({ type: "load", script, network: granted.includes("network"), ipc: ipcOn });
  });
  let seq = 0;
  const pending = new Map<number, (lines: string[]) => void>();
  worker.onmessage = (ev) => {
    if (ev.data.type === "cmdResult") pending.get(ev.data.id)?.(ev.data.lines);
    else onAux(ev);
  };
  return {
    commands: loaded.commands,
    colourRules: Array.isArray(loaded.colourRules) ? loaded.colourRules : [],
    panel: loaded.panel ?? null,
    decoders: Array.isArray(loaded.decoders) ? loaded.decoders : [],
    runCommand: (word, args) => new Promise((resolve) => { const id = ++seq; pending.set(id, resolve); worker.postMessage({ type: "cmd", id, word, args }); }),
    decode: (decId, input) => new Promise((resolve) => { const id = ++dseq; decodePending.set(id, resolve); worker.postMessage({ type: "decode", id, decId, input }); }),
    onPanel: (cb) => { panelCb = cb; },
    destroy: () => { for (const d of disposers) d(); worker.terminate(); },
  };
}
