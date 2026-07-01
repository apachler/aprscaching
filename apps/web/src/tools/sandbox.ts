/**
 * sandbox.ts — the Web Worker sandbox for IMPORTED (third-party) Tools (docs/27 B.3). Built-in tools
 * run in-process (trusted); an imported tool's script runs in a Worker with the dangerous globals
 * (fetch/XHR/WebSocket/importScripts) shadowed unless it was granted 'network'. The worker exposes a
 * tiny `register({ commands })` API and answers command invocations over postMessage. This is the
 * untrusted-code boundary; v1 supports command-type imported tools (colouriser/decoder contributions
 * stay built-in-only). Chromium-first; sandbox hardening is validate-at-deploy.
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

/** The worker bootstrap (stringified) — locks down globals, evals the tool, bridges commands. */
function workerSource(): string {
  return `
    let commands = {};
    const register = (t) => { commands = (t && t.commands) || {}; };
    self.onmessage = (ev) => {
      const m = ev.data;
      if (m.type === "load") {
        if (!m.network) { for (const g of ["fetch","XMLHttpRequest","WebSocket","importScripts"]) { try { self[g] = undefined; } catch (e) {} } }
        try { new Function("register", m.script)(register); self.postMessage({ type: "loaded", commands: Object.keys(commands) }); }
        catch (e) { self.postMessage({ type: "error", error: String(e && e.message || e) }); }
      } else if (m.type === "cmd") {
        try { const r = commands[m.word]; const out = r ? r(m.args) : ["no such command"]; self.postMessage({ type: "cmdResult", id: m.id, lines: [].concat(out).map(String) }); }
        catch (e) { self.postMessage({ type: "cmdResult", id: m.id, lines: ["error: " + (e && e.message || e)] }); }
      }
    };`;
}

export interface Sandbox { commands: string[]; runCommand(word: string, args: string): Promise<string[]>; destroy(): void }

/** Load a tool script into a locked-down worker. `granted` are the user-approved capabilities. */
export async function loadSandbox(scriptUrl: string, granted: Capability[]): Promise<Sandbox> {
  const script = await (await fetch(scriptUrl, { credentials: "omit" })).text();
  const worker = new Worker(URL.createObjectURL(new Blob([workerSource()], { type: "text/javascript" })));
  const commands = await new Promise<string[]>((resolve, reject) => {
    worker.onmessage = (ev) => { if (ev.data.type === "loaded") resolve(ev.data.commands); else if (ev.data.type === "error") reject(new Error(ev.data.error)); };
    worker.postMessage({ type: "load", script, network: granted.includes("network") });
  });
  let seq = 0;
  const pending = new Map<number, (lines: string[]) => void>();
  worker.onmessage = (ev) => { if (ev.data.type === "cmdResult") pending.get(ev.data.id)?.(ev.data.lines); };
  return {
    commands,
    runCommand: (word, args) => new Promise((resolve) => { const id = ++seq; pending.set(id, resolve); worker.postMessage({ type: "cmd", id, word, args }); }),
    destroy: () => worker.terminate(),
  };
}
