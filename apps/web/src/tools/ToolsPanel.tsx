// SPDX-License-Identifier: AGPL-3.0-or-later
import { useEffect, useRef, useState } from "react";
import {
  sanitizePanel,
  checkManifestSignature,
  decodeAprsLine,
  registryEntryFor,
  resolveTrust,
  verifyRegistry,
  PACKET_DECODER,
  type AprsDecodeResult,
  type Capability,
  type Colouriser,
  type RegistryEntry,
  type SignedRegistry,
  type Tool,
  type ToolManifest,
  type ToolTrust,
} from "@aprscaching/tools";
import { fetchToolManifest, loadSandbox, type ColourRule, type Sandbox } from "./sandbox.js";
import { API_BASE } from "../api.js";
import { listenDecode, audioDecodeSupported, type AudioCapture } from "../rf/audioDecode.js";
import {
  useToolHost,
  setToolEnabled,
  notifyToolsChanged,
  toolHost,
  addImported,
  importedTools,
  removeImported,
} from "./host.js";
import { TOOL_REGISTRY_URL, TOOL_REGISTRY_AUTHORITY } from "./registry-config.js";
import { ToolPanels } from "./ToolPanels.js";
import { PacketDecode, PACKET_SAMPLE } from "./PacketDecode.js";
import { toolIcon } from "./toolIcons.js";
import { toolPin, unpin, usePins } from "../shack/apps.js";
import { Button, Badge, Icon, Switch, ErrorState, useToast, useModalDialog } from "../ui/index.js";

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
      // a registry-listed key signed the manifest; the signature covers the manifest, not the script bytes its
      // entry URL serves (TODO.md tracks `entryHash`), so the label names the signer and claims no verified tool
      return { label: "Signed · registry-listed author key", kind: "found", blocked: false };
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
 *  `entry` is forced so the host's list tells imported tools from built-ins. */
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

/** The decoder a built-in tool contributes, so opening that tool selects it. */
const BUILTIN_DECODER: Readonly<Record<string, string>> = {
  [PACKET_DECODER.tool]: PACKET_DECODER.decoder,
  "digimode-decoders": "cw",
  sevenplus: "7plus",
};

/** The registry's own address, for resolving an entry's relative `entry` URL against it. */
const registryBase = (): string => new URL(TOOL_REGISTRY_URL, location.href).href;

/**
 * ToolsPanel — manage the sandboxed, capability-gated Tools. It drives the ONE
 * shared ToolHost, so enabling a tool here lights it up on whatever surface(s) its manifest declares
 * (packet terminal, BBS, node, or this web console) — not just here. Built-ins run in-process under the
 * capability model (off by default); imported tools are fetched by URL, permission-prompted, and run in
 * a Worker inside a sandboxed, opaque-origin frame. TX-capable tools additionally require a verified callsign. Nothing here
 * can bypass the trust engine. Any tool can be pinned to the rail; `tool` names the one to open with (a pin or a
 * `?view=tools&tool=` link): it is switched on, scrolled to, and its decoder is selected.
 */
export function ToolsPanel(props: { callsign: string; verified: boolean; tool?: string }) {
  const host = useToolHost();
  const toast = useToast();
  const { pins, toggle: togglePin } = usePins();
  const rootRef = useRef<HTMLDivElement>(null);
  const decodeRef = useRef<HTMLTextAreaElement>(null);

  const [decodeIn, setDecodeIn] = useState("");
  const [decodeKind, setDecodeKind] = useState("cw");
  const [decodeOut, setDecodeOut] = useState<string | null>(null);
  const [packet, setPacket] = useState<AprsDecodeResult | null>(null);
  const [cmd, setCmd] = useState("");
  const [cmdOut, setCmdOut] = useState<string[]>([]);
  const [asRemote, setAsRemote] = useState(false); // simulate a remote connected peer
  const [importUrl, setImportUrl] = useState("");
  const [prompt, setPrompt] = useState<{ manifest: ToolManifest; base: string; trust: ToolTrust } | null>(null);
  const [registry, setRegistry] = useState<RegistryEntry[]>([]); // verified marketplace entries (empty until loaded)
  const promptRef = useRef<HTMLDivElement>(null);
  useModalDialog(promptRef, () => setPrompt(null), !!prompt); // focus-trap + Escape + focus-restore

  // the registry load: an instance without one (404) shows no Registry section; a failed or forged one says so
  const [registryState, setRegistryState] = useState<"loading" | "ok" | "none" | "failed" | "forged">("loading");
  const [registryTry, setRegistryTry] = useState(0);

  // Load + verify the signed tool registry. We trust ONLY the pinned authority key — a forged or
  // re-hosted registry (wrong authority / edited entries) fails verifyRegistry and is dropped.
  useEffect(() => {
    let live = true;
    setRegistryState("loading");
    (async () => {
      try {
        const res = await fetch(TOOL_REGISTRY_URL, { credentials: "omit" });
        if (res.status === 404) {
          if (live) setRegistryState("none");
          return;
        }
        if (!res.ok) throw new Error(`registry ${res.status}`);
        const doc = (await res.json()) as SignedRegistry;
        const ok = await verifyRegistry(doc, TOOL_REGISTRY_AUTHORITY);
        if (!live) return;
        if (ok) setRegistry(doc.entries);
        setRegistryState(ok ? "ok" : "forged");
      } catch {
        if (live) setRegistryState("failed");
      }
    })();
    return () => {
      live = false;
    };
  }, [registryTry]);

  // imported tools live beside the host (they outlive this screen); their on/off state is the host's
  const imported = importedTools();
  const isOn = (name: string) => host.list().some((t) => t.manifest.name === name && t.enabled);
  const importedOn = imported.filter((i) => isOn(i.manifest.name));

  function toggle(name: string, on: boolean) {
    const r = setToolEnabled(name, on);
    if (!r.ok) toast(r.error ?? "couldn't enable");
  }
  function toggleImported(name: string, on: boolean) {
    toggle(name, on);
    if (!on) unpin(toolPin(name)); // a switched-off imported tool leaves the rail
  }
  function remove(im: { manifest: ToolManifest }) {
    removeImported(im.manifest.name);
    unpin(toolPin(im.manifest.name));
    toast(`Removed ${im.manifest.title}.`);
  }

  // Open the named tool: switch it on, bring its row into view, and select the decoder it contributes.
  useEffect(() => {
    const name = props.tool;
    if (!name) return;
    const t = host.list().find((x) => x.manifest.name === name);
    if (!t) return;
    if (!t.enabled) {
      const r = setToolEnabled(name, true);
      if (!r.ok) toast(`${t.manifest.title}: ${r.error ?? "couldn't switch it on"}`);
    }
    const dec = BUILTIN_DECODER[name] ?? importedTools().find((i) => i.manifest.name === name)?.sandbox.decoders[0]?.id;
    if (dec) setDecodeKind(dec);
    const raf = requestAnimationFrame(() => {
      const row = rootRef.current?.querySelector<HTMLElement>(`[data-tool="${CSS.escape(name)}"]`);
      row?.scrollIntoView({ block: "nearest" });
      if (dec && decodeRef.current) decodeRef.current.focus();
      else row?.focus();
    });
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs when the requested tool changes, not on every host update
  }, [props.tool]);

  // Web Audio mic capture → the CW/PSK31 front-ends. Live text arrives via
  // onText as the signal decodes; the pure pipeline is unit- and Chromium-e2e-tested.
  const [listening, setListening] = useState(false);
  const [liveText, setLiveText] = useState("");
  const capRef = useRef<AudioCapture | null>(null);

  // decoders merge built-in (host) + imported (worker) contributions; the selected one falls back to the first
  const allDecoders = [
    ...host.decoders().map((d) => ({ id: d.id, label: d.label })),
    ...importedOn.flatMap((i) => i.sandbox.decoders.map((d) => ({ id: d.id, label: `${d.label} (imported)` }))),
  ];
  const kind = allDecoders.some((d) => d.id === decodeKind) ? decodeKind : (allDecoders[0]?.id ?? "");
  const isPacket = kind === PACKET_DECODER.decoder;

  async function listenToggle() {
    if (listening && capRef.current) {
      const text = await capRef.current.stop().catch(() => "");
      capRef.current = null;
      setListening(false);
      setLiveText("");
      setDecodeOut(text || "(nothing decoded)");
      return;
    }
    setLiveText("");
    try {
      capRef.current = await listenDecode(kind as "cw" | "psk31", {
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
    if (isPacket) {
      setPacket(decodeAprsLine(decodeIn));
      return;
    }
    const dec = host.decoders().find((d) => d.id === kind);
    if (dec) {
      setDecodeOut(dec.decode(decodeIn.trim()));
      return;
    }
    // an imported (Worker) decoder — decode runs in the sandbox, so await the round-trip
    for (const im of importedOn)
      if (im.sandbox.decoders.some((d) => d.id === kind)) {
        setDecodeOut(await im.sandbox.decode(kind, decodeIn.trim()));
        return;
      }
    toast("Switch on a decoder tool first.");
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
    for (const im of importedOn)
      if (im.sandbox.commands.includes(word)) {
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
    // The bus names an imported tool by its manifest name, so it may not take a loaded tool's name.
    const same = host.list().find((t) => t.manifest.name === r.manifest.name);
    if (same) {
      toast(
        same.manifest.entry
          ? `"${r.manifest.name}" is already imported. Remove it first to import it again.`
          : `Refused: a built-in tool is already named "${r.manifest.name}".`,
      );
      return;
    }
    // Verify the signature (integrity) and resolve overall trust against the registry + TOFU pin (identity).
    const sig = await checkManifestSignature(r.raw);
    // Registry-listed only when fetched from the entry's own URL: the script resolves against that URL.
    const regEntry = registryEntryFor(registry, r.manifest.name, r.base, registryBase());
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
      // Bridge the sandboxed tool to the shared bus — only if it was granted 'ipc'. The host routes
      // emit/subscribe/call under the tool's own name and checks its grants on every service call; the
      // worker never holds a host or another-tool reference.
      const bridge = host.toolBus(manifest.name, manifest.permissions);
      const sandbox = await loadSandbox(scriptUrl, manifest.permissions, bridge, {
        connect: manifest.connect,
        appOrigins: [location.origin, new URL(API_BASE || location.origin, location.href).origin],
      });
      // Register the imported tool into the shared host so its colour rules + panel reach every surface
      // (terminal/BBS/node), just like a built-in. Commands + decoders stay on the async worker path.
      try {
        toolHost.register(importedAdapter(manifest, sandbox));
      } catch {
        sandbox.destroy(); // the name was taken meanwhile (a second import in flight)
        toast(`"${manifest.name}" is already imported.`);
        return;
      }
      addImported({ manifest, sandbox });
      const en = setToolEnabled(manifest.name, true);
      if (!en.ok) toast(`${manifest.title}: ${en.error ?? "some contributions disabled"}`);
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
  const builtinList = host.list().filter((t) => !t.manifest.entry);
  const decodersOn = allDecoders.length > 0;
  const cmds = [...host.commandNames(), ...importedOn.flatMap((i) => i.sandbox.commands)];

  /** One tool's row: what it is, where it runs, what it may do, and its pin and on/off switch. */
  const row = (
    m: ToolManifest,
    on: boolean,
    opts: { imported?: boolean; error?: string; onToggle: (on: boolean) => void; extra?: React.ReactNode },
  ) => {
    const pin = toolPin(m.name);
    const pinned = pins.includes(pin);
    const open = props.tool === m.name;
    return (
      <div key={m.name} className={`tool-row${open ? " open" : ""}`} data-tool={m.name} tabIndex={-1}>
        <Icon name={toolIcon(m.name, !!opts.imported)} size={20} className="tool-ic" />
        <div className="tool-meta">
          <strong>{m.title}</strong>{" "}
          <span className="muted fine">
            v{m.version} · {m.author}
            {opts.imported ? " · imported" : ""}
          </span>
          <div className="muted fine">{m.description}</div>
          <div className="tool-surfaces">
            {m.surfaces.map((s) => (
              <Badge key={s} title="Where this tool shows up">
                {s}
              </Badge>
            ))}
          </div>
          <div className="tool-perms">perms: {perms(m.permissions)}</div>
          {opts.error && <div className="error fine">{opts.error}</div>}
          {opts.extra}
        </div>
        <div className="tool-ctl">
          <Button
            variant="icon"
            className={`shack-pin${pinned ? " on" : ""}`}
            aria-pressed={pinned}
            hint={pinned ? `Unpin ${m.title} from the rail` : `Pin ${m.title} to the rail`}
            onClick={() => togglePin(pin)}
          >
            <Icon name={pinned ? "pin-off" : "pin"} size={16} />
          </Button>
          <Switch checked={on} onChange={opts.onToggle} label={m.title} />
        </div>
      </div>
    );
  };

  return (
    <div className="tools-panel" ref={rootRef}>
      <p className="muted">
        Sandboxed, capability-gated plugins. A tool's <strong>surfaces</strong> say where it runs — this console, the
        packet terminal, BBS, or the node. Everything is off by default; TX-capable tools need a verified callsign. Pin
        a tool to put it on the rail.
      </p>
      {!props.verified && (
        <p className="muted fine">Your callsign isn't verified yet — TX/beacon tools stay gated until it is.</p>
      )}

      <div className="tools-list">
        {builtinList.map((t) =>
          row(t.manifest, t.enabled, { error: t.error, onToggle: (on) => toggle(t.manifest.name, on) }),
        )}
      </div>

      {/* panels contributed by enabled `panel`-tools that target this (web) console */}
      <ToolPanels host={host} surface="web" />

      {decodersOn && (
        <div className="tool-sub">
          <div className="ulabel">Decode</div>
          <div className="row gap-2">
            <select
              value={kind}
              aria-label="Decoder"
              onChange={(e) => {
                setDecodeKind(e.target.value);
                setDecodeOut(null);
                setPacket(null);
              }}
            >
              {allDecoders.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.label}
                </option>
              ))}
            </select>
            <Button variant="primary" onClick={runDecode} disabled={!decodeIn.trim()}>
              Decode
            </Button>
            {isPacket && (
              <Button variant="quiet" onClick={() => setDecodeIn(PACKET_SAMPLE)}>
                Use a sample
              </Button>
            )}
            {audioDecodeSupported() && (kind === "cw" || kind === "psk31") && (
              <Button onClick={listenToggle} className={listening ? "primary" : ""}>
                {listening ? "Stop" : "Listen (mic)"}
              </Button>
            )}
          </div>
          {listening && (
            <div className="comment mono" aria-live="polite">
              {liveText || "listening…"}
            </div>
          )}
          <textarea
            ref={decodeRef}
            value={decodeIn}
            onChange={(e) => setDecodeIn(e.target.value)}
            rows={3}
            aria-label={isPacket ? "Raw packet" : "Text to decode"}
            placeholder={
              isPacket
                ? "paste a raw TNC2 / APRS-IS line…"
                : kind === "cw"
                  ? "…. . .-.. .-.. ---"
                  : "00…11…00 varicode bits"
            }
            className="mono"
          />
          {isPacket && packet && <PacketDecode result={packet} />}
          {!isPacket && decodeOut != null && (
            <pre className="tool-out mono" aria-live="polite">
              {decodeOut}
            </pre>
          )}
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
            <Button onClick={runCmd}>Run</Button>
          </div>
          <label className="row gap-1 fine muted">
            <input type="checkbox" checked={asRemote} onChange={(e) => setAsRemote(e.target.checked)} /> as a remote
            peer (only <code>remote</code> tools answer)
          </label>
          {cmdOut.length > 0 && <pre className="tool-out mono">{cmdOut.join("\n")}</pre>}
        </div>
      )}

      {registryState === "loading" && (
        <p className="muted fine" aria-busy="true">
          Loading the tool registry…
        </p>
      )}
      {registryState === "failed" && (
        <ErrorState onRetry={() => setRegistryTry((n) => n + 1)}>
          Couldn&apos;t load the tool registry. You can still import a tool by its URL below.
        </ErrorState>
      )}
      {registryState === "forged" && (
        <ErrorState>
          The tool registry failed its signature check, so its tools are not listed. Tell the instance&apos;s sysop.
        </ErrorState>
      )}
      {registryState === "ok" && registry.length === 0 && (
        <p className="muted fine">The tool registry lists no tools yet.</p>
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
                </span>
                {e.description && <div className="muted fine">{e.description}</div>}
              </div>
              <Button
                onClick={() => {
                  const url = new URL(e.entry, registryBase()).href;
                  setImportUrl(url);
                  startImport(url);
                }}
              >
                Import…
              </Button>
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
          <Button onClick={() => startImport()}>Import…</Button>
        </div>
        <p className="muted fine">
          Signed tools are verified against their author key; unsigned tools import with a warning. An invalid signature
          or a changed author key is refused. An imported tool stays until you remove it or reload the page.
        </p>
        {imported.length > 0 && (
          <div className="tools-list">
            {imported.map((im) =>
              row(im.manifest, isOn(im.manifest.name), {
                imported: true,
                onToggle: (on) => toggleImported(im.manifest.name, on),
                extra: (
                  <div className="row gap-2 mt-1">
                    {im.sandbox.commands.length > 0 && (
                      <span className="muted fine mono">/{im.sandbox.commands.join(" /")}</span>
                    )}
                    <Button variant="quiet" onClick={() => remove(im)}>
                      Remove
                    </Button>
                  </div>
                ),
              }),
            )}
          </div>
        )}
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
              {prompt.manifest.connect?.length ? (
                <p className="tool-surfaces">
                  connects to: <span className="mono">{prompt.manifest.connect.join(", ")}</span>
                </p>
              ) : null}
              <p>
                <Badge kind={ti.kind}>{ti.label}</Badge>
              </p>
              <p className="muted fine">
                It runs in a sealed frame, apart from your session, passkeys and stored keys. It reaches the network
                only with the <code>network</code> capability, and then only the origins listed above. TX still requires
                your verified callsign.
              </p>
              <div className="row gap-2 end">
                <Button onClick={() => setPrompt(null)}>Cancel</Button>
                <Button variant="primary" onClick={approveImport}>
                  Approve + run
                </Button>
              </div>
            </div>
          );
        })()}
    </div>
  );
}
