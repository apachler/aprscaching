// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * installed.ts — the tools a player installed. A fresh player has none: each tool is installed on demand from a
 * registry (or by its address), after the player approves its permissions, and from then on it is part of the
 * player's own setup. The record of each install (the manifest's address, the author key and the grants approved,
 * and whether it is switched on) lives in localStorage under `acs.tools` and follows the account like the rail pins
 * do (prefs.ts), so a reload or a second device starts the same tools again.
 *
 * Starting a recorded tool checks it again every time: the manifest's signature must verify under the author key
 * recorded at install, the manifest may ask for no permission beyond those approved, and the script must match the
 * hash the signed manifest pins. A tool that fails a check stays installed but does not run, and the Tools app says
 * why; installing it again is how the player approves a new key or new permissions.
 */
import { useEffect, useReducer } from "react";
import { checkManifestSignature, type ToolManifest } from "@aprscaching/tools";
import { API_BASE } from "../api.js";
import { notePrefChange, PREFS_EVENT } from "../prefs.js";
import { loadSandbox, fetchToolManifest, sandboxTool, type Sandbox } from "./sandbox.js";
import { carrierVia, fetchToolScript, type Carrier, type RegistryVia } from "./registries.js";
import {
  INSTALLED_KEY,
  MAX_INSTALLED,
  normalizeInstalled,
  withRecord,
  type InstalledRecord,
} from "./installedRecords.js";
import { notifyToolsChanged, onToolsChanged, setToolEnabled, toolHost } from "./host.js";

export function readInstalled(): InstalledRecord[] {
  try {
    return normalizeInstalled(JSON.parse(localStorage.getItem(INSTALLED_KEY) || "[]"));
  } catch {
    return [];
  }
}

function writeInstalled(list: InstalledRecord[]): void {
  try {
    localStorage.setItem(INSTALLED_KEY, JSON.stringify(list));
  } catch {
    /* storage blocked: the install lasts for this page only */
  }
  notePrefChange(); // mirror to the account (if signed in)
  notifyToolsChanged();
}

// ---- what runs in this page: the loaded sandboxes, the tools starting, and why a recorded tool did not start ----

/** A running tool: its manifest and the sandbox its commands and decoders run in. */
export interface LoadedTool {
  manifest: ToolManifest;
  sandbox: Sandbox;
}
const loaded = new Map<string, LoadedTool>();
const starting = new Set<string>();
const problems = new Map<string, string>();

/** Stop a running tool: its frame closes and the host forgets it, so its name is free again. */
function stop(name: string): void {
  const t = loaded.get(name);
  if (!t) return;
  t.sandbox.destroy();
  loaded.delete(name);
  toolHost.unregister(name);
}

/** Run a checked manifest: fetch its script (refused unless it matches the signed hash), sandbox it, register it. */
async function run(manifest: ToolManifest, base: string, carrier: Carrier): Promise<string | null> {
  const code = await fetchToolScript(manifest, new URL(manifest.entry ?? "tool.js", base).href, carrier);
  if (!code.ok) return code.error;
  if (toolHost.list().some((t) => t.manifest.name === manifest.name)) return "a tool of that name is already running";
  const sandbox = await loadSandbox(code.script, manifest.permissions, {
    connect: manifest.connect,
    appOrigins: [location.origin, new URL(API_BASE || location.origin, location.href).origin],
    onChange: notifyToolsChanged,
  });
  try {
    toolHost.register(sandboxTool(manifest, sandbox));
  } catch {
    sandbox.destroy(); // the name was taken meanwhile (a second start in flight)
    return "a tool of that name is already running";
  }
  loaded.set(manifest.name, { manifest, sandbox });
  return null;
}

/** Start one recorded tool, checking its manifest, key, grants and code again. Null on success, else why not. */
async function start(rec: InstalledRecord): Promise<string | null> {
  const carrier = carrierVia(rec.via, API_BASE);
  const r = await fetchToolManifest(rec.url, carrier);
  if (!r.ok) return `its manifest can't be loaded (${r.error})`;
  if (r.manifest.name !== rec.name) return "its manifest names another tool";
  if ((await checkManifestSignature(r.raw)) !== "valid") return "its signature does not verify";
  if (r.manifest.pubkey !== rec.pubkey) return "it is signed by another key now; install it again to check the new key";
  const extra = r.manifest.permissions.filter((p) => !rec.grants.includes(p));
  if (extra.length) return `it asks for ${extra.join(", ")} now; install it again to approve`;
  return run(r.manifest, r.base, carrier);
}

async function startRecorded(rec: InstalledRecord): Promise<void> {
  if (loaded.has(rec.name) || starting.has(rec.name)) return;
  starting.add(rec.name);
  problems.delete(rec.name);
  notifyToolsChanged();
  let why: string | null;
  try {
    why = await start(rec);
  } catch (e) {
    why = (e as Error).message || "it did not start";
  }
  starting.delete(rec.name);
  if (why) problems.set(rec.name, why);
  else if (rec.on) setToolEnabled(rec.name, true);
  notifyToolsChanged();
}

/**
 * Bring this page in line with the records: start each recorded tool that is not running, and stop each running
 * tool that is no longer recorded (removed on another device). Runs at start-up and after an account sync.
 */
export function syncInstalled(): Promise<void> {
  const recs = readInstalled();
  for (const name of [...loaded.keys()]) if (!recs.some((r) => r.name === name)) stop(name);
  return Promise.all(recs.filter((r) => !problems.has(r.name)).map(startRecorded)).then(() => undefined);
}

let syncing = false;
/** Start the player's tools once per page, and again whenever an account sync rewrites the records. */
export function startInstalledTools(): void {
  if (syncing || typeof window === "undefined") return;
  syncing = true;
  window.addEventListener(PREFS_EVENT, () => {
    problems.clear();
    void syncInstalled();
  });
  void syncInstalled();
}

/**
 * Install an approved tool: run it, then record it switched on. `base` is the manifest's address and `pubkey` the
 * key its signature verified under. Null on success, else why it did not install.
 */
export async function installTool(opts: {
  manifest: ToolManifest;
  base: string;
  carrier: Carrier;
  via?: RegistryVia;
}): Promise<string | null> {
  const { manifest, base, carrier, via } = opts;
  if (!manifest.pubkey) return "the manifest is unsigned";
  if (readInstalled().length >= MAX_INSTALLED && !readInstalled().some((r) => r.name === manifest.name))
    return `at most ${MAX_INSTALLED} tools can be installed`;
  stop(manifest.name); // installing again replaces the running copy (a new key or new permissions approved)
  problems.delete(manifest.name);
  const why = await run(manifest, base, carrier);
  if (why) return why;
  writeInstalled(
    withRecord(readInstalled(), {
      name: manifest.name,
      url: base,
      pubkey: manifest.pubkey,
      grants: manifest.permissions,
      on: true,
      ...(via ? { via } : {}),
    }),
  );
  setToolEnabled(manifest.name, true);
  return null;
}

/** Switch an installed tool on or off, and remember it. */
export function setInstalledOn(name: string, on: boolean): { ok: boolean; error?: string } {
  const r = setToolEnabled(name, on);
  if (r.ok) writeInstalled(readInstalled().map((x) => (x.name === name ? { ...x, on } : x)));
  return r;
}

/** Try a tool that did not start once more. */
export function retryInstalled(name: string): void {
  const rec = readInstalled().find((r) => r.name === name);
  if (!rec) return;
  problems.delete(name);
  void startRecorded(rec);
}

/** Uninstall a tool: it stops, and its record goes. */
export function removeInstalled(name: string): void {
  stop(name);
  problems.delete(name);
  starting.delete(name);
  writeInstalled(readInstalled().filter((r) => r.name !== name));
}

/** One installed tool as the Tools app shows it. */
export interface InstalledView {
  record: InstalledRecord;
  tool?: LoadedTool;
  on: boolean;
  starting: boolean;
  problem?: string;
}

/** The installed tools, in install order, with what each is doing in this page; re-renders on every change. */
export function useInstalled(): InstalledView[] {
  const [, force] = useReducer((n) => n + 1, 0);
  useEffect(() => onToolsChanged(force), []);
  const enabled = new Set(
    toolHost
      .list()
      .filter((t) => t.enabled)
      .map((t) => t.manifest.name),
  );
  return readInstalled().map((record) => ({
    record,
    tool: loaded.get(record.name),
    on: enabled.has(record.name),
    starting: starting.has(record.name),
    problem: problems.get(record.name),
  }));
}
