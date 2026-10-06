// SPDX-License-Identifier: AGPL-3.0-or-later
import { useEffect, useRef, useState } from "react";
import {
  checkManifestSignature,
  resolveTrust,
  type Capability,
  type ToolManifest,
  type ToolTrust,
} from "@aprscaching/tools";
import { fetchToolManifest } from "./sandbox.js";
import { API_BASE } from "../api.js";
import { listenDecode, audioDecodeSupported, type AudioCapture } from "../rf/audioDecode.js";
import { useToolHost } from "./host.js";
import {
  installTool,
  removeInstalled,
  retryInstalled,
  setInstalledOn,
  useInstalled,
  type InstalledView,
} from "./installed.js";
import { carrierFor, DIRECT, listingFor, viaFor, type Carrier, type Listing, type RegistryVia } from "./registries.js";
import { MyRegistries, RegistryGroups, useReconfirm, useToolRegistries } from "./RegistryViews.js";
import { ToolPanels } from "./ToolPanels.js";
import { toolIcon } from "./toolIcons.js";
import { toolPin, unpin, usePins } from "../shack/apps.js";
import { Button, Badge, EmptyState, Icon, Switch, useConfirm, useToast, useModalDialog } from "../ui/index.js";

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

/** A short, human trust line + whether the install may proceed. `invalid`/`key-changed` are hard-refused. */
function trustInfo(t: ToolTrust): { label: string; kind: "found" | "warn" | "dnf"; blocked: boolean } {
  switch (t) {
    case "verified":
      return { label: "Signed · registry-listed author key", kind: "found", blocked: false };
    case "known":
      return { label: "Signed · matches the key you trusted before", kind: "found", blocked: false };
    case "self-signed":
      return { label: "Signed · unknown author key (trust-on-first-use)", kind: "warn", blocked: false };
    case "unsigned":
      return { label: "Unsigned — refused", kind: "dnf", blocked: true };
    case "key-changed":
      return { label: "Author key CHANGED since you last trusted it — refused", kind: "dnf", blocked: true };
    case "invalid":
      return { label: "Signature INVALID — refused", kind: "dnf", blocked: true };
  }
}

/** The registry list shows a filter once it lists more tools than this. */
const FILTER_FROM = 7;

/**
 * ToolsPanel — the player's tools. The app ships none: a tool is installed on demand from a registry (or by its
 * address), after its signature and code are checked and the player approves its permissions, and it then runs in
 * a sandboxed, opaque-origin frame. The installed tools drive the ONE shared ToolHost, so switching a tool on lights
 * it up on whatever surface(s) its manifest declares (packet terminal, BBS, node, the map or this console). The
 * installs, their switches and their rail pins follow the player (installed.ts, prefs.ts). TX-capable tools need a
 * verified callsign and this tab's transmit consent. `tool` names the one to open with (a pin or a
 * `?view=tools&tool=` link): it is switched on, scrolled to, and its decoder is selected; a tool not installed yet
 * is looked up in the registry.
 */
export function ToolsPanel(props: { callsign: string; verified: boolean; tool?: string }) {
  const host = useToolHost();
  const toast = useToast();
  const confirm = useConfirm();
  const { pins, toggle: togglePin } = usePins();
  const installed = useInstalled();
  const rootRef = useRef<HTMLDivElement>(null);
  const decodeRef = useRef<HTMLTextAreaElement>(null);
  const registryRef = useRef<HTMLDivElement>(null);
  const filterRef = useRef<HTMLInputElement>(null);

  const [decodeIn, setDecodeIn] = useState("");
  const [decodeKind, setDecodeKind] = useState("cw");
  const [decodeOut, setDecodeOut] = useState<string | null>(null);
  const [cmd, setCmd] = useState("");
  const [cmdOut, setCmdOut] = useState<string[]>([]);
  const [asRemote, setAsRemote] = useState(false); // simulate a remote connected peer
  const [importUrl, setImportUrl] = useState("");
  const [filter, setFilter] = useState("");
  const [missing, setMissing] = useState<string | null>(null);
  const [prompt, setPrompt] = useState<{
    manifest: ToolManifest;
    base: string;
    trust: ToolTrust;
    carrier: Carrier;
    via?: RegistryVia;
    listedBy?: string;
  } | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const promptRef = useRef<HTMLDivElement>(null);
  useModalDialog(promptRef, () => setPrompt(null), !!prompt); // focus-trap + Escape + focus-restore
  // every configured registry, each loaded and checked against its pinned key on its own
  const registries = useToolRegistries();
  const reconfirm = useReconfirm("my", registries.reload);

  const running = installed.filter((v) => v.on && v.tool);
  const installedNames = new Set(installed.map((v) => v.record.name));

  function toggle(v: InstalledView, on: boolean) {
    setInstalledOn(v.record.name, on);
    if (!on) unpin(toolPin(v.record.name)); // a switched-off tool leaves the rail
  }
  async function remove(v: InstalledView) {
    const title = v.tool?.manifest.title ?? v.record.title;
    const ok = await confirm({
      title: `Remove ${title}?`,
      message: "It stops, leaves the rail and is no longer installed. You can install it again from the registry.",
      confirmLabel: "Remove",
      danger: true,
    });
    if (!ok) return;
    removeInstalled(v.record.name);
    unpin(toolPin(v.record.name));
    toast(`Removed ${title}.`);
  }
  const showRegistry = (name = "") => {
    setFilter(name);
    requestAnimationFrame(() => {
      registryRef.current?.scrollIntoView({ block: "start" });
      filterRef.current?.focus();
    });
  };

  // Open the named tool: switch it on, bring its row into view, and select the decoder it contributes. A tool not
  // installed yet is looked up in the registry.
  const toolInstalled = !!props.tool && installedNames.has(props.tool);
  const toolLoaded = !!props.tool && !!installed.find((v) => v.record.name === props.tool)?.tool;
  useEffect(() => {
    const name = props.tool;
    if (!name) return;
    if (!toolInstalled) {
      setMissing(name);
      showRegistry(name);
      return;
    }
    setMissing(null);
    const v = installed.find((x) => x.record.name === name);
    if (!v) return;
    if (!v.on) {
      toggle(v, true); // it loads; this runs again once it is
      return;
    }
    if (!v.tool) return; // still starting: this runs again once it is loaded
    const dec = v.tool.sandbox.decoders[0]?.id;
    if (dec) setDecodeKind(dec);
    const raf = requestAnimationFrame(() => {
      const row = rootRef.current?.querySelector<HTMLElement>(`[data-tool="${CSS.escape(name)}"]`);
      row?.scrollIntoView({ block: "nearest" });
      if (dec && decodeRef.current) decodeRef.current.focus();
      else row?.focus();
    });
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs when the requested tool changes or arrives, not on every host update
  }, [props.tool, toolInstalled, toolLoaded]);

  // Web Audio mic capture → the CW/PSK31 front-ends. Live text arrives via
  // onText as the signal decodes; the pure pipeline is unit- and Chromium-e2e-tested.
  const [listening, setListening] = useState(false);
  const [liveText, setLiveText] = useState("");
  const capRef = useRef<AudioCapture | null>(null);

  // the decoders of every running tool; the selected one falls back to the first
  const allDecoders = running.flatMap((v) => v.tool!.sandbox.decoders.map((d) => ({ ...d, tool: v.tool! })));
  const decoder = allDecoders.find((d) => d.id === decodeKind) ?? allDecoders[0];
  const kind = decoder?.id ?? "";

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
    if (!decoder) {
      toast("Switch on a decoder tool first.");
      return;
    }
    setDecodeOut(await decoder.tool.sandbox.decode(decoder.id, decodeIn.trim()));
  }
  async function runCmd() {
    const word = cmd.replace(/^\//, "").split(/\s+/)[0] ?? "";
    const args = cmd.replace(/^\/?\S+\s*/, "");
    for (const v of running) {
      const { manifest, sandbox } = v.tool!;
      if (!sandbox.commands.includes(word)) continue;
      // a remote peer reaches only a remote tool's commands, and not the ones it keeps for the operator
      if (asRemote && (!manifest.remote || sandbox.remoteOff.includes(word))) continue;
      setCmdOut(await sandbox.runCommand(word, args));
      setCmd("");
      return;
    }
    setCmdOut([asRemote ? `no command "${word}" answers a remote peer` : `no such command "${word}"`]);
  }
  /** Look at a tool by its manifest's upstream address; `carrier` fetches it (through this instance for a carried
   *  registry). Checks the signature and code pin, then asks the player to approve its permissions. */
  async function startInstall(url = importUrl, carrier: Carrier = DIRECT, via?: RegistryVia) {
    if (!url.trim()) return;
    setImportError(null);
    const r = await fetchToolManifest(url.trim(), carrier);
    if (!r.ok) {
      setImportError(r.error);
      return;
    }
    // The bus names a tool by its manifest name, so a second tool may not take an installed tool's name.
    const same = installed.find((v) => v.record.name === r.manifest.name);
    if (same && same.record.url !== r.base) {
      toast(`Refused: you already have a tool named "${r.manifest.name}". Remove it first.`);
      return;
    }
    // Verify the signature (integrity) and resolve overall trust against the registries + TOFU pin (identity).
    const sig = await checkManifestSignature(r.raw);
    // Registry-listed only when fetched from the entry's own URL: the script resolves against that URL.
    const listed = listingFor(registries.loaded, r.manifest.name, r.base, location.href);
    const trust = resolveTrust(sig, {
      registryPubkey: listed?.entry.pubkey,
      pinnedPubkey: tofuMap()[r.manifest.author.toUpperCase()],
      pubkey: r.manifest.pubkey,
    });
    if (trustInfo(trust).blocked) {
      setImportError(`Refused: ${trustInfo(trust).label}`);
      return;
    } // never even prompt
    if (!r.manifest.entrySha256) {
      setImportError("Refused: the manifest pins no hash of its code (entrySha256), so its code can't be checked.");
      return;
    }
    setPrompt({
      manifest: r.manifest,
      base: r.base,
      trust,
      carrier,
      via,
      listedBy: listed && `${listed.from.reg.label}${listed.from.reg.scope === "account" ? " (yours)" : ""}`,
    });
  }
  async function approveInstall() {
    if (!prompt) return;
    const { manifest, base, trust, carrier, via } = prompt;
    if (trustInfo(trust).blocked) {
      setPrompt(null);
      return;
    }
    if ((trust === "self-signed" || trust === "known" || trust === "verified") && manifest.pubkey)
      tofuPin(manifest.author, manifest.pubkey); // pin on trust
    setPrompt(null);
    try {
      const why = await installTool({ manifest, base, carrier, via });
      if (why) {
        setImportError(`Refused: ${why}.`);
        return;
      }
      setMissing(null);
      toast(`Installed ${manifest.title}.`);
    } catch (e) {
      setImportError(`Install failed: ${(e as Error).message}`);
    }
  }

  const perms = (p: Capability[]) => p.join(", ") || "none";
  const cmds = running.flatMap((v) => v.tool!.sandbox.commands);
  const listedCount = registries.loaded.reduce((n, l) => n + (l.state.kind === "ok" ? l.state.entries.length : 0), 0);
  const missingListed =
    missing != null &&
    registries.loaded.some((l) => l.state.kind === "ok" && l.state.entries.some((e) => e.name === missing));

  /** One installed tool's row: what it is, where it runs, what it may do, its state, pin, switch and removal. */
  const row = (v: InstalledView) => {
    const m = v.tool?.manifest;
    const name = v.record.name;
    const title = m?.title ?? v.record.title;
    const pin = toolPin(name);
    const pinned = pins.includes(pin);
    const open = props.tool === name;
    return (
      <div key={name} className={`tool-row${open ? " open" : ""}`} data-tool={name} tabIndex={-1}>
        <Icon name={toolIcon(name)} size={20} className="tool-ic" />
        <div className="tool-meta">
          <strong>{title}</strong>{" "}
          {m && (
            <span className="muted fine">
              v{m.version} · {m.author}
            </span>
          )}
          {m?.description && <div className="muted fine">{m.description}</div>}
          {m && (
            <div className="tool-surfaces">
              {m.surfaces.map((s) => (
                <Badge key={s} title="Where this tool shows up">
                  {s}
                </Badge>
              ))}
            </div>
          )}
          <div className="tool-perms">perms: {perms(m?.permissions ?? v.record.grants)}</div>
          {v.starting && (
            <div className="muted fine" role="status">
              Starting…
            </div>
          )}
          {v.problem && (
            <div className="error fine" role="alert">
              Not running: {v.problem}.
            </div>
          )}
          <div className="row gap-2 mt-1">
            {v.tool && v.tool.sandbox.commands.length > 0 && (
              <span className="muted fine mono">/{v.tool.sandbox.commands.join(" /")}</span>
            )}
            {v.problem && <Button onClick={() => retryInstalled(name)}>Try again</Button>}
            <Button variant="quiet" onClick={() => void remove(v)} hint={`Uninstall ${title}`}>
              Remove
            </Button>
          </div>
        </div>
        <div className="tool-ctl">
          <Button
            variant="icon"
            className={`shack-pin${pinned ? " on" : ""}`}
            aria-pressed={pinned}
            disabled={!v.tool}
            hint={pinned ? `Unpin ${title} from the rail` : `Pin ${title} to the rail`}
            onClick={() => togglePin(pin)}
          >
            <Icon name={pinned ? "pin-off" : "pin"} size={16} />
          </Button>
          <Switch checked={v.on} disabled={v.starting} onChange={(on) => toggle(v, on)} label={title} />
        </div>
      </div>
    );
  };

  return (
    <div className="tools-panel" ref={rootRef}>
      <p className="muted">
        Signed plugins you install from a registry. Each runs sealed off from your session and reaches only what you
        approve. A tool&apos;s <strong>surfaces</strong> say where it runs: this console, the packet terminal, BBS, the
        node or the map. TX-capable tools need a verified callsign. Pin a tool to put it on the rail.
      </p>
      {!props.verified && (
        <p className="muted fine">Your callsign isn&apos;t verified yet — TX/beacon tools stay gated until it is.</p>
      )}

      <section className="tools-mine" aria-labelledby="tools-mine-h">
        <div className="ulabel" id="tools-mine-h">
          Your tools
        </div>
        {installed.length === 0 ? (
          <EmptyState
            action={
              <Button variant="primary" onClick={() => showRegistry()}>
                Browse the registry
              </Button>
            }
          >
            No tools installed. Install the ones you want from the registry below: decoders, macros, MHeard, the packet
            decoder and more.
          </EmptyState>
        ) : (
          <div className="tools-list">{installed.map(row)}</div>
        )}
      </section>

      {/* panels contributed by running `panel`-tools that target this (web) console */}
      <ToolPanels host={host} surface="web" />

      {decoder && (
        <div className="tool-sub">
          <div className="ulabel">Decode</div>
          <div className="row gap-2">
            <select
              value={kind}
              aria-label="Decoder"
              onChange={(e) => {
                setDecodeKind(e.target.value);
                setDecodeOut(null);
              }}
            >
              {allDecoders.map((d) => (
                <option key={`${d.tool.manifest.name}:${d.id}`} value={d.id}>
                  {d.label}
                </option>
              ))}
            </select>
            <Button variant="primary" onClick={runDecode} disabled={!decodeIn.trim()}>
              Decode
            </Button>
            {decoder.sample && (
              <Button variant="quiet" onClick={() => setDecodeIn(decoder.sample!)}>
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
            aria-label={`Input for ${decoder.label}`}
            placeholder={decoder.placeholder ?? "text to decode"}
            className="mono"
          />
          {decodeOut != null && (
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
              placeholder={`/${cmds[0]}`}
              aria-label="Tool command"
              onKeyDown={(e) => {
                if (e.key === "Enter") void runCmd();
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

      <div className="tool-sub" ref={registryRef}>
        <div className="ulabel">Registry</div>
        <p className="muted fine">
          Signed lists of tools. Each registry is pinned to its publisher&apos;s key; a tool listed by several shows
          once.
        </p>
        {missing &&
          (missingListed ? (
            <p className="muted fine" role="status">
              That tool isn&apos;t installed yet. Install it from the list below.
            </p>
          ) : (
            registries.loaded.every((l) => l.state.kind !== "loading") && (
              <p className="muted fine" role="status">
                No registry here lists a tool named <span className="mono">{missing}</span>.
              </p>
            )
          ))}
        {registries.listError && (
          <p className="muted fine">
            This instance can&apos;t be asked for its registries ({registries.listError}); showing the one bundled with
            the app.
          </p>
        )}
        {registries.list && registries.loaded.length === 0 && (
          <p className="muted fine">No registry is switched on. You can still install a tool by its address below.</p>
        )}
        {listedCount > FILTER_FROM && (
          <input
            ref={filterRef}
            type="search"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Find a tool"
            aria-label="Find a tool in the registries"
          />
        )}
      </div>
      <RegistryGroups
        loaded={registries.loaded}
        installed={installedNames}
        filter={filter}
        onInstall={(x: Listing) => {
          setImportUrl(x.manifestUrl);
          void startInstall(x.manifestUrl, carrierFor(x.from.reg, API_BASE), viaFor(x.from.reg));
        }}
        onRetry={registries.retry}
        onReconfirm={(reg, authority, fp) => void reconfirm(reg, authority, fp)}
      />
      {registries.list?.players.signedIn && <MyRegistries list={registries.list} onChanged={registries.reload} />}

      <div className="tool-sub">
        <div className="ulabel">
          Install by address <span className="muted fine">(a tool.json URL)</span>
        </div>
        <div className="row gap-2">
          <input
            value={importUrl}
            onChange={(e) => setImportUrl(e.target.value)}
            placeholder="https://…/tool.json"
            aria-label="Tool manifest URL"
          />
          <Button onClick={() => startInstall()}>Install…</Button>
        </div>
        <p className="muted fine">
          A tool must be signed by its author, and its code must match the hash its signed manifest pins. An unsigned
          tool, an invalid signature, a changed author key or changed code is refused. Installed tools follow you to
          your other devices once you sign in, and their checks run again each time they start.
        </p>
        {importError && (
          <p className="error fine" role="alert">
            {importError}
          </p>
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
              {(prompt.manifest.permissions.includes("tx") || prompt.manifest.permissions.includes("beacon")) && (
                <p>
                  <strong>May transmit status and messages under your callsign</strong>, at most once a minute and six
                  times an hour.
                </p>
              )}
              {prompt.manifest.remote && (
                <p className="tool-surfaces">Stations connected to you may run its remote commands.</p>
              )}
              <p className="tool-surfaces">surfaces: {prompt.manifest.surfaces.join(", ")}</p>
              {prompt.manifest.connect?.length ? (
                <p className="tool-surfaces">
                  connects to: <span className="mono">{prompt.manifest.connect.join(", ")}</span>
                </p>
              ) : null}
              <p>
                <Badge kind={ti.kind}>{ti.label}</Badge>
              </p>
              {prompt.listedBy && <p className="tool-surfaces">listed by: {prompt.listedBy}</p>}
              <p className="muted fine">
                It runs in a sealed frame, apart from your session, passkeys and stored keys. It reaches the network
                only with the <code>network</code> capability, and then only the origins listed above. A tool transmits
                only with your verified callsign and the consent you give this tab, at most once a minute.
              </p>
              <div className="row gap-2 end">
                <Button onClick={() => setPrompt(null)}>Cancel</Button>
                <Button variant="primary" onClick={approveInstall}>
                  Approve and install
                </Button>
              </div>
            </div>
          );
        })()}
    </div>
  );
}
