// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * sandbox.ts — the sandbox for IMPORTED (third-party) Tools. Built-in tools run in-process (trusted); an
 * imported tool's script runs in a Worker that lives inside an `<iframe sandbox="allow-scripts" srcdoc>`.
 * The frame has an opaque origin, so the tool shares no storage, cookies, IndexedDB keys or service worker
 * with the app, and the frame's CSP limits its connections to the origins its manifest lists in `connect`
 * when it holds the 'network' grant (none otherwise). Without that grant the worker's network globals are
 * shadowed as well. The worker exposes a `register({ commands, colourRules, panel, decoders })` API + an
 * `ipc` bridge, and answers command/decode calls over postMessage, which the frame relays. Contributions
 * reach every surface the same way built-ins do: the host adapter (ToolsPanel) wires the DECLARATIVE ones
 * (colour rules, panel) into the shared ToolHost synchronously, while code-bearing ones (commands,
 * decoders) round-trip to the worker asynchronously. Every message from the frame is shape-checked here.
 */
import { validateManifest, type ToolManifest, type Capability } from "@aprscaching/tools";

export async function fetchToolManifest(
  url: string,
): Promise<{ ok: true; manifest: ToolManifest; base: string } | { ok: false; error: string }> {
  try {
    const res = await fetch(url, { credentials: "omit" });
    if (!res.ok) return { ok: false, error: `manifest ${res.status}` };
    const v = validateManifest(await res.json());
    if (!v.ok) return v;
    return { ok: true, manifest: v.manifest, base: new URL(url, location.href).href };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/** The bus bridge the host provides to an imported tool (only wired when it was granted 'ipc'). */
export interface IpcBridge {
  emit(topic: string, data: unknown): void;
  subscribe(topic: string, cb: (data: unknown, from: string) => void): () => void;
  call(name: string, args: unknown): unknown;
}

/** A declarative monitor colour rule — evaluated host-side (sync), so no per-line Worker round-trip. */
export interface ColourRule {
  srcPrefix?: string;
  dstPrefix?: string;
  textIncludes?: string;
  colorVar?: string;
  hidden?: boolean;
}
/** Decoder metadata an imported tool contributes; the decode itself runs in the worker (async). */
export interface DecoderMeta {
  id: string;
  label: string;
  kind: string;
}

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
        if (!m.network) { for (const g of ["fetch","XMLHttpRequest","WebSocket","WebTransport","EventSource","importScripts","Worker","SharedWorker"]) { try { self[g] = undefined; } catch (e) {} } }
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

/** How long the frame may take to start the worker and load the tool before the import fails. */
const LOAD_TIMEOUT_MS = 15_000;
const MAX_LIST = 200;

/**
 * The frame's Content-Security-Policy. Scripts run inline and from blob: (the worker), and the worker
 * evaluates the tool's source. Connections go to `connect` only; an empty list blocks every request.
 */
export function frameCsp(connect: string[]): string {
  return [
    "default-src 'none'",
    "script-src 'unsafe-inline' 'unsafe-eval' blob:",
    "worker-src blob:",
    `connect-src ${connect.length ? connect.join(" ") : "'none'"}`,
    "base-uri 'none'",
    "form-action 'none'",
  ].join("; ");
}

/**
 * The origins a tool's frame may connect to: its manifest's `connect` list when it holds the 'network'
 * grant, minus the app's own origins (the page and the API, in http and ws form), so a tool never
 * addresses the app's API from inside the sandbox.
 */
export function connectSources(granted: Capability[], connect: string[] | undefined, appOrigins: string[]): string[] {
  if (!granted.includes("network") || !connect?.length) return [];
  const own = new Set<string>();
  for (const o of appOrigins) {
    try {
      const u = new URL(o);
      own.add(`${u.protocol}//${u.host}`);
      own.add(`${u.protocol === "https:" ? "wss:" : "ws:"}//${u.host}`);
    } catch {
      /* not a URL */
    }
  }
  return connect.filter((o) => !own.has(o));
}

/** The frame document: its CSP, then a relay between the parent window and the tool's worker. */
export function frameSource(csp: string): string {
  // `<` is escaped so the worker source can never close the inline script element.
  const src = JSON.stringify(workerSource()).replace(/</g, "\\u003c");
  const attr = csp.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
  return `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${attr}"><script>
const w = new Worker(URL.createObjectURL(new Blob([${src}], { type: "text/javascript" })));
w.onmessage = (e) => parent.postMessage(e.data, "*");
w.onerror = (e) => { e.preventDefault(); parent.postMessage({ type: "error", error: String(e.message || "tool worker failed") }, "*"); };
addEventListener("message", (e) => { if (e.source === parent) w.postMessage(e.data); });
parent.postMessage({ type: "ready" }, "*");
</script>`;
}

/** One message from the frame, after its shape is checked. Anything else is dropped. */
export type FrameMessage =
  | { type: "ready" }
  | { type: "error"; error: string }
  | { type: "loaded"; commands: string[]; colourRules: ColourRule[]; panel: unknown | null; decoders: DecoderMeta[] }
  | { type: "cmdResult"; id: number; lines: string[] }
  | { type: "decodeResult"; id: number; out: string }
  | { type: "panel"; spec: unknown }
  | { type: "emit"; topic: string; data: unknown }
  | { type: "subscribe"; topic: string }
  | { type: "call"; id: number; name: string; args: unknown };

const isStr = (x: unknown): x is string => typeof x === "string";
const isId = (x: unknown): x is number => typeof x === "number" && Number.isSafeInteger(x);
const optStr = (x: unknown): string | undefined => (isStr(x) ? x : undefined);

function colourRule(x: unknown): ColourRule | null {
  if (typeof x !== "object" || x === null) return null;
  const r = x as Record<string, unknown>;
  return {
    srcPrefix: optStr(r.srcPrefix),
    dstPrefix: optStr(r.dstPrefix),
    textIncludes: optStr(r.textIncludes),
    colorVar: optStr(r.colorVar),
    hidden: r.hidden === true,
  };
}

function decoderMeta(x: unknown): DecoderMeta | null {
  if (typeof x !== "object" || x === null) return null;
  const d = x as Record<string, unknown>;
  return isStr(d.id) && isStr(d.label) && isStr(d.kind) ? { id: d.id, label: d.label, kind: d.kind } : null;
}

function listOf<T>(x: unknown, f: (v: unknown) => T | null): T[] {
  if (!Array.isArray(x)) return [];
  const out: T[] = [];
  for (const v of x.slice(0, MAX_LIST)) {
    const r = f(v);
    if (r !== null) out.push(r);
  }
  return out;
}

/** Check the shape of a message from the frame; `null` for anything that is not one of the known kinds. */
export function parseFrameMessage(data: unknown): FrameMessage | null {
  if (typeof data !== "object" || data === null) return null;
  const m = data as Record<string, unknown>;
  switch (m.type) {
    case "ready":
      return { type: "ready" };
    case "error":
      return { type: "error", error: isStr(m.error) ? m.error.slice(0, 500) : "tool failed" };
    case "loaded":
      return {
        type: "loaded",
        commands: listOf(m.commands, (v) => (isStr(v) ? v : null)),
        colourRules: listOf(m.colourRules, colourRule).slice(0, 40),
        panel: m.panel ?? null,
        decoders: listOf(m.decoders, decoderMeta),
      };
    case "cmdResult":
      return isId(m.id) && Array.isArray(m.lines) ? { type: "cmdResult", id: m.id, lines: m.lines.map(String) } : null;
    case "decodeResult":
      return isId(m.id) && isStr(m.out) ? { type: "decodeResult", id: m.id, out: m.out } : null;
    case "panel":
      return { type: "panel", spec: m.spec };
    case "emit":
      return isStr(m.topic) ? { type: "emit", topic: m.topic, data: m.data } : null;
    case "subscribe":
      return isStr(m.topic) ? { type: "subscribe", topic: m.topic } : null;
    case "call":
      return isId(m.id) && isStr(m.name) ? { type: "call", id: m.id, name: m.name, args: m.args } : null;
    default:
      return null;
  }
}

export interface Sandbox {
  commands: string[];
  colourRules: ColourRule[];
  panel: unknown | null; // initial declarative PanelSpec (sanitised by the host adapter)
  decoders: DecoderMeta[];
  runCommand(word: string, args: string): Promise<string[]>;
  decode(id: string, input: string): Promise<string>;
  onPanel(cb: (spec: unknown) => void): void; // dynamic panel updates (ipc.setPanel from the worker)
  destroy(): void;
}

export interface SandboxOptions {
  /** The manifest's `connect` origins; reachable only with the 'network' grant. */
  connect?: string[];
  /** The app's own origins (page and API), which the frame never connects to. */
  appOrigins?: string[];
}

/**
 * Load a tool script into a worker inside a sandboxed frame. `granted` are the user-approved
 * capabilities; `bridge` (supplied only when 'ipc' was granted) wires the worker's emit/subscribe/call to
 * the host bus. `destroy()` removes the frame, which ends its worker.
 */
export async function loadSandbox(
  scriptUrl: string,
  granted: Capability[],
  bridge?: IpcBridge,
  opts: SandboxOptions = {},
): Promise<Sandbox> {
  const script = await (await fetch(scriptUrl, { credentials: "omit" })).text();
  const network = granted.includes("network");
  const csp = frameCsp(connectSources(granted, opts.connect, opts.appOrigins ?? [location.origin]));
  const frame = document.createElement("iframe");
  frame.setAttribute("sandbox", "allow-scripts");
  frame.setAttribute("aria-hidden", "true");
  frame.tabIndex = -1;
  frame.hidden = true;
  frame.srcdoc = frameSource(csp);

  const ipcOn = granted.includes("ipc") && !!bridge;
  const disposers: Array<() => void> = [];
  let panelCb: ((spec: unknown) => void) | null = null;
  const pending = new Map<number, (lines: string[]) => void>();
  const decodePending = new Map<number, (out: string) => void>();
  let seq = 0;
  let dseq = 0;
  // The frame's origin is opaque, so "*" is the only target origin postMessage accepts for it.
  const post = (msg: unknown) => frame.contentWindow?.postMessage(msg, "*");

  let onLoad: ((m: FrameMessage) => void) | null = null;
  const onMessage = (ev: MessageEvent) => {
    if (!frame.contentWindow || ev.source !== frame.contentWindow) return;
    const m = parseFrameMessage(ev.data);
    if (!m) return;
    if (m.type === "ready" || m.type === "loaded" || m.type === "error") {
      onLoad?.(m);
      return;
    }
    switch (m.type) {
      case "cmdResult":
        pending.get(m.id)?.(m.lines);
        pending.delete(m.id);
        return;
      case "decodeResult":
        decodePending.get(m.id)?.(m.out);
        decodePending.delete(m.id);
        return;
      case "panel":
        panelCb?.(m.spec);
        return;
    }
    // The host routes the bus; payloads stay opaque.
    if (!ipcOn || !bridge) return;
    if (m.type === "emit") bridge.emit(m.topic, m.data);
    else if (m.type === "subscribe")
      disposers.push(bridge.subscribe(m.topic, (data, from) => post({ type: "ipcEvent", topic: m.topic, data, from })));
    else if (m.type === "call") post({ type: "callResult", id: m.id, result: bridge.call(m.name, m.args) });
  };

  const destroy = () => {
    window.removeEventListener("message", onMessage);
    for (const d of disposers) d();
    disposers.length = 0;
    frame.remove();
  };

  window.addEventListener("message", onMessage);
  let loaded: Extract<FrameMessage, { type: "loaded" }>;
  try {
    loaded = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("the tool did not start in time")), LOAD_TIMEOUT_MS);
      onLoad = (m) => {
        if (m.type === "ready") {
          post({ type: "load", script, network, ipc: ipcOn });
          return;
        }
        clearTimeout(timer);
        if (m.type === "loaded") resolve(m);
        else if (m.type === "error") reject(new Error(m.error));
      };
      document.body.appendChild(frame);
    });
  } catch (e) {
    destroy();
    throw e;
  } finally {
    onLoad = null;
  }

  return {
    commands: loaded.commands,
    colourRules: loaded.colourRules,
    panel: loaded.panel,
    decoders: loaded.decoders,
    runCommand: (word, args) =>
      new Promise((resolve) => {
        const id = ++seq;
        pending.set(id, resolve);
        post({ type: "cmd", id, word, args });
      }),
    decode: (decId, input) =>
      new Promise((resolve) => {
        const id = ++dseq;
        decodePending.set(id, resolve);
        post({ type: "decode", id, decId, input });
      }),
    onPanel: (cb) => {
      panelCb = cb;
    },
    destroy,
  };
}
