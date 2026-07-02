/**
 * sandbox.ts — the Web Worker sandbox for IMPORTED (third-party) Tools (docs/27 B.3). Built-in tools
 * run in-process (trusted); an imported tool's script runs in a Worker with the dangerous globals
 * (fetch/XHR/WebSocket/importScripts) shadowed unless it was granted 'network'. The worker exposes a
 * tiny `register({ commands, ipc })` API and answers command invocations over postMessage. This is the
 * untrusted-code boundary; imported tools reach the inter-tool bus (docs/28 §5f) only through the
 * postMessage bridge below — the host relays their emit/subscribe/call, so a sandboxed tool can
 * cooperate without ever holding a reference to the host or another tool. Chromium-first; sandbox
 * hardening is validate-at-deploy.
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

/** The worker bootstrap (stringified) — locks down globals, evals the tool, bridges commands + IPC. */
function workerSource(): string {
  return `
    let commands = {};
    const subs = {};                       // topic → [cb] the tool subscribed to
    const pendingCalls = {}; let callSeq = 0;
    const ipc = {
      emit: (topic, data) => self.postMessage({ type: "emit", topic, data }),
      subscribe: (topic, cb) => { (subs[topic] = subs[topic] || []).push(cb); self.postMessage({ type: "subscribe", topic }); },
      call: (name, args) => new Promise((res) => { const id = ++callSeq; pendingCalls[id] = res; self.postMessage({ type: "call", id, name, args }); }),
    };
    const register = (t) => { commands = (t && t.commands) || {}; };
    self.onmessage = (ev) => {
      const m = ev.data;
      if (m.type === "load") {
        if (!m.network) { for (const g of ["fetch","XMLHttpRequest","WebSocket","importScripts"]) { try { self[g] = undefined; } catch (e) {} } }
        try { new Function("register", "ipc", m.script)(register, m.ipc ? ipc : undefined); self.postMessage({ type: "loaded", commands: Object.keys(commands) }); }
        catch (e) { self.postMessage({ type: "error", error: String(e && e.message || e) }); }
      } else if (m.type === "cmd") {
        try { const r = commands[m.word]; const out = r ? r(m.args) : ["no such command"]; self.postMessage({ type: "cmdResult", id: m.id, lines: [].concat(out).map(String) }); }
        catch (e) { self.postMessage({ type: "cmdResult", id: m.id, lines: ["error: " + (e && e.message || e)] }); }
      } else if (m.type === "ipcEvent") {
        for (const cb of subs[m.topic] || []) { try { cb(m.data, m.from); } catch (e) {} }
      } else if (m.type === "callResult") {
        const res = pendingCalls[m.id]; if (res) { delete pendingCalls[m.id]; res(m.result); }
      }
    };`;
}

export interface Sandbox { commands: string[]; runCommand(word: string, args: string): Promise<string[]>; destroy(): void }

/**
 * Load a tool script into a locked-down worker. `granted` are the user-approved capabilities; `bridge`
 * (supplied only when 'ipc' was granted) wires the worker's emit/subscribe/call to the host bus.
 */
export async function loadSandbox(scriptUrl: string, granted: Capability[], bridge?: IpcBridge): Promise<Sandbox> {
  const script = await (await fetch(scriptUrl, { credentials: "omit" })).text();
  const worker = new Worker(URL.createObjectURL(new Blob([workerSource()], { type: "text/javascript" })));
  const ipcOn = granted.includes("ipc") && !!bridge;
  const disposers: Array<() => void> = [];

  // Bridge worker → host bus (only if 'ipc' granted). The host routes; payloads stay opaque.
  const onBusMessage = (ev: MessageEvent) => {
    const m = ev.data;
    if (!ipcOn || !bridge) return;
    if (m.type === "emit") bridge.emit(String(m.topic), m.data);
    else if (m.type === "subscribe") disposers.push(bridge.subscribe(String(m.topic), (data, from) => worker.postMessage({ type: "ipcEvent", topic: m.topic, data, from })));
    else if (m.type === "call") worker.postMessage({ type: "callResult", id: m.id, result: bridge.call(String(m.name), m.args) });
  };

  const commands = await new Promise<string[]>((resolve, reject) => {
    worker.onmessage = (ev) => {
      if (ev.data.type === "loaded") resolve(ev.data.commands);
      else if (ev.data.type === "error") reject(new Error(ev.data.error));
      else onBusMessage(ev);
    };
    worker.postMessage({ type: "load", script, network: granted.includes("network"), ipc: ipcOn });
  });
  let seq = 0;
  const pending = new Map<number, (lines: string[]) => void>();
  worker.onmessage = (ev) => {
    if (ev.data.type === "cmdResult") pending.get(ev.data.id)?.(ev.data.lines);
    else onBusMessage(ev);
  };
  return {
    commands,
    runCommand: (word, args) => new Promise((resolve) => { const id = ++seq; pending.set(id, resolve); worker.postMessage({ type: "cmd", id, word, args }); }),
    destroy: () => { for (const d of disposers) d(); worker.terminate(); },
  };
}
