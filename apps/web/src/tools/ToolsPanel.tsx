// SPDX-License-Identifier: AGPL-3.0-or-later
import { useEffect, useRef, useState } from "react";
import {
  sanitizePanel,
  checkManifestSignature,
  resolveTrust,
  verifyRegistry,
  type Capability,
  type Colouriser,
  type RegistryEntry,
  type SignedRegistry,
  type Tool,
  type ToolManifest,
  type ToolTrust,
} from "@aprsweb/tools";
import { fetchToolManifest, loadSandbox, type ColourRule, type Sandbox } from "./sandbox.js";
import { listenDecode, audioDecodeSupported, type AudioCapture } from "../rf/audioDecode.js";
import { useToolHost, setToolEnabled, notifyToolsChanged, toolHost, TOOLS_TOAST_EVENT } from "./host.js";
import { TOOL_REGISTRY_URL, TOOL_REGISTRY_AUTHORITY } from "./registry-config.js";
import { ToolPanels } from "./ToolPanels.js";
import { Badge, Switch, useToast, useModalDialog } from "../ui/index.js";

// ---- trust-on-first-use pin store (author callsign → last-seen author pubkey) ----
const TOFU_KEY = "acs.tool.keys";
function tofuMap(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(TOFU_KEY) || "{}");
  } catch {
    return {};
  }
}
function tofuPin(author: string, pubkey: string): void {
  try {
    const m = tofuMap();
    m[author.toUpperCase()] = pubkey;
    localStorage.setItem(TOFU_KEY, JSON.stringify(m));
  } catch {
    /* ignore */
  }
}

/** A short, human trust line + whether the import may proceed. `invalid`/`key-changed` are hard-refused. */
function trustInfo(t: ToolTrust): { label: string; kind: "found" | "warn" | "dnf"; blocked: boolean } {
  switch (t) {
    case "verified":
      return { label: "Verified · registry-listed author key", kind: "found", blocked: false };
    case "known":
      return { label: "Signed · matches the key you trusted before", kind: "found", blocked: false };
    case "self-signed":
      return { label: "Signed · unknown author key (trust-on-first-use)", kind: "warn", blocked: false };
    case "unsigned":
      return { label: "Unsigned · you're trusting the URL only", kind: "warn", blocked: false };
    case "key-changed":
      return { label: "Author key CHANGED since you last trusted it — refused", kind: "dnf", blocked: true };
    case "invalid":
      return { label: "Signature INVALID — refused", kind: "dnf", blocked: true };
  }
}

/** Compile an imported tool's declarative colour rules into a sync colouriser (no per-line Worker call). */
function compileRules(rules: ColourRule[]): Colouriser {
  const safeVar = (v?: string) => (v && /^--[a-z0-9-]+$/i.test(v) ? v : undefined);
  return (line) => {
    for (const r of rules) {
      if (!r.srcPrefix && !r.dstPrefix && !r.textIncludes) continue; // a rule must match on something
      if (r.srcPrefix && !line.src.toUpperCase().startsWith(r.srcPrefix.toUpperCase())) continue;
      if (r.dstPrefix && !line.dst.toUpperCase().startsWith(r.dstPrefix.toUpperCase())) continue;
      if (r.textIncludes && !line.text.includes(r.textIncludes)) continue;
      return { colorVar: safeVar(r.colorVar), hidden: !!r.hidden };
    }
    return null;
  };
}

/** Wrap an imported (Worker) tool as a host adapter Tool so its DECLARATIVE contributions (colour rules,
 *  panel) reach every surface exactly like a built-in. Commands + decoders stay on the async worker path.
 *  `entry` is forced so ToolsPanel's built-in list can filter imported adapters out (no duplicate row). */
function importedAdapter(manifest: ToolManifest, sandbox: Sandbox): Tool {
  return {
    manifest: { ...manifest, entry: manifest.entry ?? "tool.js" },
    activate(ctx) {
      if (sandbox.colourRules.length && ctx.granted("monitor")) ctx.addColouriser(compileRules(sandbox.colourRules));
      if (ctx.granted("panel")) {
        if (sandbox.panel) ctx.setPanel(sanitizePanel(sandbox.panel));
        sandbox.onPanel((spec) => {
          try {
            ctx.setPanel(sanitizePanel(spec));
            notifyToolsChanged();
          } catch {
            /* bad spec */
          }
        });
      }
    },
  };
}

/**
 * ToolsPanel — manage the sandboxed, capability-gated Tools. It drives the ONE
 * shared ToolHost, so enabling a tool here lights it up on whatever surface(s) its manifest declares
 * (packet terminal, BBS, node, or this web console) — not just here. Built-ins run in-process under the
 * capability model (off by default); imported tools are fetched by URL, permission-prompted, and run in
 * a locked-down Worker. TX-capable tools additionally require a verified callsign. Nothing here
 * can bypass the trust engine.
 */
interface Imported {
  manifest: ToolManifest;
  sandbox: Sandbox;
  enabled: boolean;
}

export function ToolsPanel(props: { callsign: string; verified: boolean }) {
  const host = useToolHost();
  const toast = useToast();

  const [decodeIn, setDecodeIn] = useState("");
  const [decodeKind, setDecodeKind] = useState("cw");
  const [cmd, setCmd] = useState("");
  const [cmdOut, setCmdOut] = useState<string[]>([]);
  const [asRemote, setAsRemote] = useState(false); // simulate a remote connected peer
  const [importUrl, setImportUrl] = useState("");
  const [prompt, setPrompt] = useState<{ manifest: ToolManifest; base: string; trust: ToolTrust } | null>(null);
  const [imported, setImported] = useState<Imported[]>([]);
  const [registry, setRegistry] = useState<RegistryEntry[]>([]); // verified marketplace entries (empty until loaded)
  const promptRef = useRef<HTMLDivElement>(null);
  useModalDialog(promptRef, () => setPrompt(null), !!prompt); // focus-trap + Escape + focus-restore

  // Load + verify the signed tool registry once. We trust ONLY the pinned authority key — a forged or
  // re-hosted registry (wrong authority / edited entries) fails verifyRegistry and is dropped.
  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const res = await fetch(TOOL_REGISTRY_URL, { credentials: "omit" });
        if (!res.ok) return;
        const doc = (await res.json()) as SignedRegistry;
        if (live && (await verifyRegistry(doc, TOOL_REGISTRY_AUTHORITY))) setRegistry(doc.entries);
      } catch {
        /* no/invalid registry → browse just shows empty */
      }
    })();
    return () => {
      live = false;
    };
  }, []);

  // Surface beacon/TX feedback the shared host emits (it can't hold a React toast itself).
  useEffect(() => {
    const h = (e: Event) => toast((e as CustomEvent<string>).detail);
    window.addEventListener(TOOLS_TOAST_EVENT, h);
    return () => window.removeEventListener(TOOLS_TOAST_EVENT, h);
  }, [toast]);

  // Live panels (mheard, etc.) update their spec from background events, not React state — tick a
  // gentle re-render so the web console reflects new frames without any per-tool wiring.
  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 4_000);
    return () => clearInterval(id);
  }, []);

  function toggle(name: string, on: boolean) {
    const r = setToolEnabled(name, on);
    if (!r.ok) toast(r.error ?? "couldn't enable");
  }
  // Web Audio mic capture → the CW/PSK31 front-ends. Live text arrives via
  // onText as the signal decodes; the pure pipeline is unit- and Chromium-e2e-tested.
  const [listening, setListening] = useState(false);
  const [liveText, setLiveText] = useState("");
  const capRef = useRef<AudioCapture | null>(null);
  async function listenToggle() {
    if (listening && capRef.current) {
      const text = await capRef.current.stop().catch(() => "");
      capRef.current = null;
      setListening(false);
      setLiveText("");
      setDecodeIn((v) => `${v}\n→ ${text || "(nothing decoded)"}`);
      return;
    }
    setLiveText("");
    try {
      capRef.current = await listenDecode(decodeKind as "cw" | "psk31", {
        pitchHz: 700,
        carrierHz: 1000,
        onText: setLiveText,
      });
      setListening(true);
    } catch (e) {
      toast(`Mic: ${(e as Error).message}`);
    }
  }

  async function runDecode() {
    const dec = host.decoders().find((d) => d.id === decodeKind);
    if (dec) {
      setDecodeIn((v) => `${v}\n→ ${dec.decode(v.trim())}`);
      return;
    }
    // an imported (Worker) decoder — decode runs in the sandbox, so await the round-trip
    for (const im of imported)
      if (im.enabled && im.sandbox.decoders.some((d) => d.id === decodeKind)) {
        const out = await im.sandbox.decode(decodeKind, decodeIn.trim());
        setDecodeIn((v) => `${v}\n→ ${out}`);
        return;
      }
    toast("Enable a decoder tool first.");
  }
  async function runCmd() {
    const word = cmd.replace(/^\//, "").split(/\s+/)[0] ?? "";
    const args = cmd.replace(/^\/?\S+\s*/, "");
    const built = host.runCommand(word, args, undefined, { remote: asRemote });
    if (built) {
      setCmdOut(built);
      setCmd("");
      return;
    }
    for (const im of imported)
      if (im.enabled && im.sandbox.commands.includes(word)) {
        setCmdOut(await im.sandbox.runCommand(word, args));
        setCmd("");
        return;
      }
    setCmdOut([`no such command "${word}"`]);
  }
  async function startImport(url = importUrl) {
    if (!url.trim()) return;
    const r = await fetchToolManifest(url.trim());
    if (!r.ok) {
      toast(r.error);
      return;
    }
    // Verify the signature (integrity) and resolve overall trust against the registry + TOFU pin (identity).
    const sig = await checkManifestSignature(r.manifest);
    const regEntry = registry.find((e) => e.name === r.manifest.name);
    const trust = resolveTrust(sig, {
      registryPubkey: regEntry?.pubkey,
      pinnedPubkey: tofuMap()[r.manifest.author.toUpperCase()],
      pubkey: r.manifest.pubkey,
    });
    if (trustInfo(trust).blocked) {
      toast(`Refused: ${trustInfo(trust).label}`);
      return;
    } // never even prompt
    setPrompt({ manifest: r.manifest, base: r.base, trust });
  }
  async function approveImport() {
    if (!prompt) return;
    const { manifest, base, trust } = prompt;
    if (trustInfo(trust).blocked) {
      setPrompt(null);
      return;
    }
    if ((trust === "self-signed" || trust === "known" || trust === "verified") && manifest.pubkey)
      tofuPin(manifest.author, manifest.pubkey); // pin on trust
    setPrompt(null);
    try {
      const scriptUrl = new URL(manifest.entry ?? "tool.js", base).href;
      // Bridge the sandboxed tool to the shared bus — only if it was granted 'ipc'. The
      // host routes emit/subscribe/call; the worker never holds a host or another-tool reference.
      const bridge = {
        emit: (t: string, d: unknown) => host.hostEmit(t, d),
        subscribe: (t: string, cb: (data: unknown, from: string) => void) => host.hostSubscribe(t, cb),
        call: (n: string, a: unknown) => host.hostCallService(n, a),
      };
      const sandbox = await loadSandbox(scriptUrl, manifest.permissions, bridge);
      // Register the imported tool into the shared host so its colour rules + panel reach every surface
      // (terminal/BBS/node), just like a built-in. Commands + decoders stay on the async worker path below.
      try {
        toolHost.register(importedAdapter(manifest, sandbox));
        const en = setToolEnabled(manifest.name, true);
        if (!en.ok) toast(`${manifest.title}: ${en.error ?? "some contributions disabled"}`);
      } catch {
        /* name already registered (dup import / HMR) — commands still work via the worker path */
      }
      setImported((xs) => [...xs, { manifest, sandbox, enabled: true }]);
      const extras = [
        sandbox.colourRules.length && "colours",
        sandbox.panel && "panel",
        sandbox.decoders.length && "decoders",
      ]
        .filter(Boolean)
        .join(", ");
      toast(`Imported ${manifest.title} (${sandbox.commands.length} commands${extras ? `, ${extras}` : ""}).`);
    } catch (e) {
      toast(`Import failed: ${(e as Error).message}`);
    }
  }

  const perms = (p: Capability[]) => p.join(", ") || "none";
  // decoders + commands merge built-in (host) + imported (worker) contributions; imported adapters are
  // filtered out of the built-in LIST (they carry `entry`) so they don't render as a duplicate row.
  const builtinList = host.list().filter((t) => !t.manifest.entry);
  const allDecoders = [
    ...host.decoders().map((d) => ({ id: d.id, label: d.label })),
    ...imported
      .filter((i) => i.enabled)
      .flatMap((i) => i.sandbox.decoders.map((d) => ({ id: d.id, label: `${d.label} (imported)` }))),
  ];
  const decodersOn = allDecoders.length > 0;
  const cmds = [...host.commandNames(), ...imported.filter((i) => i.enabled).flatMap((i) => i.sandbox.commands)];

  return (
    <div className="tools-panel">
      <p className="muted">
        Sandboxed, capability-gated plugins. A tool's <strong>surfaces</strong> say where it runs — this console, the
        packet terminal, BBS, or the node. Everything is off by default; TX-capable tools need a verified callsign.
      </p>
      {!props.verified && (
        <p className="muted fine">Your callsign isn't verified yet — TX/beacon tools stay gated until it is.</p>
      )}

      <div className="tools-list">
        {builtinList.map((t) => (
          <div key={t.manifest.name} className="tool-row">
            <div className="tool-meta">
              <strong>{t.manifest.title}</strong>{" "}
              <span className="muted fine">
                v{t.manifest.version} · {t.manifest.author}
              </span>
              <div className="muted fine">{t.manifest.description}</div>
              <div className="tool-surfaces">
                {t.manifest.surfaces.map((s) => (
                  <Badge key={s}>{s}</Badge>
                ))}
              </div>
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
          <div className="ulabel">Decode</div>
          <div className="row gap-2">
            <select value={decodeKind} onChange={(e) => setDecodeKind(e.target.value)}>
              {allDecoders.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.label}
                </option>
              ))}
            </select>
            <button onClick={runDecode}>Decode</button>
            {audioDecodeSupported() && (decodeKind === "cw" || decodeKind === "psk31") && (
              <button onClick={listenToggle} className={listening ? "primary" : ""}>
                {listening ? "Stop" : "Listen (mic)"}
              </button>
            )}
          </div>
          {listening && (
            <div className="comment mono" aria-live="polite">
              {liveText || "listening…"}
            </div>
          )}
          <textarea
            value={decodeIn}
            onChange={(e) => setDecodeIn(e.target.value)}
            rows={3}
            placeholder={decodeKind === "cw" ? "…. . .-.. .-.. ---" : "00…11…00 varicode bits"}
            className="mono"
          />
        </div>
      )}

      {cmds.length > 0 && (
        <div className="tool-sub">
          <div className="ulabel">
            Run a tool command <span className="muted fine">({cmds.map((c) => `/${c}`).join(" ")})</span>
          </div>
          <div className="row gap-2">
            <input
              value={cmd}
              onChange={(e) => setCmd(e.target.value)}
              placeholder="/cq"
              aria-label="Tool command"
              onKeyDown={(e) => {
                if (e.key === "Enter") runCmd();
              }}
            />
            <button onClick={runCmd}>Run</button>
          </div>
          <label className="row gap-1 fine muted">
            <input type="checkbox" checked={asRemote} onChange={(e) => setAsRemote(e.target.checked)} /> as a remote
            peer (only <code>remote</code> tools answer)
          </label>
          {cmdOut.length > 0 && <pre className="tool-out mono">{cmdOut.join("\n")}</pre>}
        </div>
      )}

      {registry.length > 0 && (
        <div className="tool-sub">
          <div className="ulabel">
            Registry <span className="muted fine">(signed marketplace — {registry.length})</span>
          </div>
          {registry.map((e) => (
            <div key={e.name} className="tool-row">
              <div className="tool-meta">
                <strong>{e.title}</strong>{" "}
                <span className="muted fine">
                  v{e.version} · {e.author}
                </span>{" "}
                <Badge kind="found">verified</Badge>
                {e.description && <div className="muted fine">{e.description}</div>}
              </div>
              <button
                onClick={() => {
                  setImportUrl(e.entry);
                  startImport(e.entry);
                }}
              >
                Import…
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="tool-sub">
        <div className="ulabel">
          Import a tool <span className="muted fine">(by tool.json URL)</span>
        </div>
        <div className="row gap-2">
          <input
            value={importUrl}
            onChange={(e) => setImportUrl(e.target.value)}
            placeholder="https://…/tool.json"
            aria-label="Tool manifest URL"
          />
          <button onClick={() => startImport()}>Import…</button>
        </div>
        <p className="muted fine">
          Signed tools are verified against their author key; unsigned tools import with a warning. An invalid signature
          or a changed author key is refused.
        </p>
        {imported.map((im) => (
          <div key={im.manifest.name} className="muted fine">
            ✓ {im.manifest.title} — /{im.sandbox.commands.join(" /")}
          </div>
        ))}
      </div>

      {prompt &&
        (() => {
          const ti = trustInfo(prompt.trust);
          return (
            <div
              className="tool-prompt"
              role="dialog"
              aria-modal="true"
              aria-label="Approve tool permissions"
              ref={promptRef}
            >
              <p>
                <strong>{prompt.manifest.title}</strong> by <span className="mono">{prompt.manifest.author}</span>{" "}
                requests:
              </p>
              <p className="tool-perms">{perms(prompt.manifest.permissions)}</p>
              <p className="tool-surfaces">surfaces: {prompt.manifest.surfaces.join(", ")}</p>
              <p>
                <Badge kind={ti.kind}>{ti.label}</Badge>
              </p>
              <p className="muted fine">
                It will run sandboxed in a Worker. Network access is blocked unless it requested (and you approve) the{" "}
                <code>network</code> capability. TX still requires your verified callsign.
              </p>
              <div className="row gap-2 end">
                <button onClick={() => setPrompt(null)}>Cancel</button>
                <button className="primary" onClick={approveImport}>
                  Approve + run
                </button>
              </div>
            </div>
          );
        })()}
    </div>
  );
}
