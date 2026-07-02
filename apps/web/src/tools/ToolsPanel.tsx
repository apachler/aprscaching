import { useEffect, useRef, useState } from "react";
import { type Capability, type ToolManifest } from "@aprsweb/tools";
import { fetchToolManifest, loadSandbox, type Sandbox } from "./sandbox.js";
import { useToolHost, setToolEnabled, TOOLS_TOAST_EVENT } from "./host.js";
import { ToolPanels } from "./ToolPanels.js";
import { Badge, Switch, useToast, useModalDialog } from "../ui/index.js";

/**
 * ToolsPanel (docs/27 B.3 / docs/28) — manage the sandboxed, capability-gated Tools. It drives the ONE
 * shared ToolHost, so enabling a tool here lights it up on whatever surface(s) its manifest declares
 * (packet terminal, BBS, node, or this web console) — not just here. Built-ins run in-process under the
 * capability model (off by default); imported tools are fetched by URL, permission-prompted, and run in
 * a locked-down Worker. TX-capable tools additionally require a verified callsign (H5). Nothing here
 * can bypass the trust engine.
 */
interface Imported { manifest: ToolManifest; sandbox: Sandbox; enabled: boolean }

export function ToolsPanel(props: { callsign: string; verified: boolean }) {
  const host = useToolHost();
  const toast = useToast();

  const [decodeIn, setDecodeIn] = useState("");
  const [decodeKind, setDecodeKind] = useState("cw");
  const [cmd, setCmd] = useState("");
  const [cmdOut, setCmdOut] = useState<string[]>([]);
  const [asRemote, setAsRemote] = useState(false); // simulate a remote connected peer (docs/28 D)
  const [importUrl, setImportUrl] = useState("");
  const [prompt, setPrompt] = useState<{ manifest: ToolManifest; base: string } | null>(null);
  const [imported, setImported] = useState<Imported[]>([]);
  const promptRef = useRef<HTMLDivElement>(null);
  useModalDialog(promptRef, () => setPrompt(null), !!prompt); // focus-trap + Escape + focus-restore

  // Surface beacon/TX feedback the shared host emits (it can't hold a React toast itself).
  useEffect(() => {
    const h = (e: Event) => toast((e as CustomEvent<string>).detail);
    window.addEventListener(TOOLS_TOAST_EVENT, h);
    return () => window.removeEventListener(TOOLS_TOAST_EVENT, h);
  }, [toast]);

  function toggle(name: string, on: boolean) {
    const r = setToolEnabled(name, on);
    if (!r.ok) toast(r.error ?? "couldn't enable");
  }
  function runDecode() {
    const dec = host.decoders().find((d) => d.id === decodeKind);
    if (!dec) { toast("Enable the PSK31/CW decoders tool first."); return; }
    setDecodeIn((v) => `${v}\n→ ${dec.decode(v.trim())}`);
  }
  async function runCmd() {
    const word = cmd.replace(/^\//, "").split(/\s+/)[0] ?? "";
    const args = cmd.replace(/^\/?\S+\s*/, "");
    const built = host.runCommand(word, args, undefined, { remote: asRemote });
    if (built) { setCmdOut(built); setCmd(""); return; }
    for (const im of imported) if (im.enabled && im.sandbox.commands.includes(word)) { setCmdOut(await im.sandbox.runCommand(word, args)); setCmd(""); return; }
    setCmdOut([`no such command "${word}"`]);
  }
  async function startImport() {
    if (!importUrl.trim()) return;
    const r = await fetchToolManifest(importUrl.trim());
    if (!r.ok) { toast(r.error); return; }
    setPrompt({ manifest: r.manifest, base: r.base });
  }
  async function approveImport() {
    if (!prompt) return;
    const { manifest, base } = prompt;
    setPrompt(null);
    try {
      const scriptUrl = new URL(manifest.entry ?? "tool.js", base).href;
      const sandbox = await loadSandbox(scriptUrl, manifest.permissions);
      setImported((xs) => [...xs, { manifest, sandbox, enabled: true }]);
      toast(`Imported ${manifest.title} (${sandbox.commands.length} commands).`);
    } catch (e) { toast(`Import failed: ${(e as Error).message}`); }
  }

  const perms = (p: Capability[]) => p.join(", ") || "none";
  const decodersOn = host.decoders().length > 0;
  const cmds = [...host.commandNames(), ...imported.filter((i) => i.enabled).flatMap((i) => i.sandbox.commands)];

  return (
    <div className="tools-panel">
      <p className="muted">Sandboxed, capability-gated plugins. A tool's <strong>surfaces</strong> say where it runs — this console, the packet terminal, BBS, or the node. Everything is off by default; TX-capable tools need a verified callsign.</p>
      {!props.verified && <p className="muted fine">Your callsign isn't verified yet — TX/beacon tools stay gated until it is.</p>}

      <div className="tools-list">
        {host.list().map((t) => (
          <div key={t.manifest.name} className="tool-row">
            <div className="tool-meta">
              <strong>{t.manifest.title}</strong> <span className="muted fine">v{t.manifest.version} · {t.manifest.author}</span>
              <div className="muted fine">{t.manifest.description}</div>
              <div className="tool-surfaces">{t.manifest.surfaces.map((s) => <Badge key={s}>{s}</Badge>)}</div>
              <div className="tool-perms">perms: {perms(t.manifest.permissions)}</div>
              {t.error && <div className="error fine">{t.error}</div>}
            </div>
            <Switch checked={t.enabled} onChange={(on) => toggle(t.manifest.name, on)} label={t.manifest.title} />
          </div>
        ))}
      </div>

      {/* panels contributed by enabled `panel`-tools that target this (web) console */}
      <ToolPanels host={host} surface="web" />

      {decodersOn && (
        <div className="tool-sub">
          <div className="ulabel">Decode (F-5)</div>
          <div className="row gap-2">
            <select value={decodeKind} onChange={(e) => setDecodeKind(e.target.value)}>
              {host.decoders().map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
            </select>
            <button onClick={runDecode}>Decode</button>
          </div>
          <textarea value={decodeIn} onChange={(e) => setDecodeIn(e.target.value)} rows={3}
            placeholder={decodeKind === "cw" ? "…. . .-.. .-.. ---" : "00…11…00 varicode bits"} className="mono" />
        </div>
      )}

      {cmds.length > 0 && (
        <div className="tool-sub">
          <div className="ulabel">Run a tool command <span className="muted fine">({cmds.map((c) => `/${c}`).join(" ")})</span></div>
          <div className="row gap-2">
            <input value={cmd} onChange={(e) => setCmd(e.target.value)} placeholder="/cq" aria-label="Tool command" onKeyDown={(e) => { if (e.key === "Enter") runCmd(); }} />
            <button onClick={runCmd}>Run</button>
          </div>
          <label className="row gap-1 fine muted"><input type="checkbox" checked={asRemote} onChange={(e) => setAsRemote(e.target.checked)} /> as a remote peer (only <code>remote</code> tools answer)</label>
          {cmdOut.length > 0 && <pre className="tool-out mono">{cmdOut.join("\n")}</pre>}
        </div>
      )}

      <div className="tool-sub">
        <div className="ulabel">Import a tool <span className="muted fine">(by tool.json URL)</span></div>
        <div className="row gap-2">
          <input value={importUrl} onChange={(e) => setImportUrl(e.target.value)} placeholder="https://…/tool.json" aria-label="Tool manifest URL" />
          <button onClick={startImport}>Import…</button>
        </div>
        {imported.map((im) => (
          <div key={im.manifest.name} className="muted fine">✓ {im.manifest.title} — /{im.sandbox.commands.join(" /")}</div>
        ))}
      </div>

      {prompt && (
        <div className="tool-prompt" role="dialog" aria-modal="true" aria-label="Approve tool permissions" ref={promptRef}>
          <p><strong>{prompt.manifest.title}</strong> by <span className="mono">{prompt.manifest.author}</span> requests:</p>
          <p className="tool-perms">{perms(prompt.manifest.permissions)}</p>
          <p className="tool-surfaces">surfaces: {prompt.manifest.surfaces.join(", ")}</p>
          <p className="muted fine">It will run sandboxed in a Worker. Network access is blocked unless it requested (and you approve) the <code>network</code> capability. TX still requires your verified callsign.</p>
          <div className="row gap-2 end">
            <button onClick={() => setPrompt(null)}>Cancel</button>
            <button className="primary" onClick={approveImport}>Approve + run</button>
          </div>
        </div>
      )}
    </div>
  );
}
