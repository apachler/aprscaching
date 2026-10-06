// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * installedRecords.ts — the record of a player's installed tools as settings keep it (localStorage `acs.tools`,
 * synced to the account), the check every stored or synced list passes, and the test of a manifest against what
 * the player approved. Pure, so tests share it.
 */
import { connectOrigin, isCapability, type Capability, type ToolManifest } from "@aprscaching/tools";
import type { RegistryVia } from "./registries.js";

/** One installed tool as the player's settings keep it: what the player approved, and the switch. */
export interface InstalledRecord {
  name: string;
  /** The title the Tools app shows while the tool is not loaded. */
  title: string;
  /** The manifest's upstream address. */
  url: string;
  /** The author key the manifest was signed with when the player approved it. */
  pubkey: string;
  /** The permissions the player approved. */
  grants: Capability[];
  /** The origins the player approved for `network`. */
  connect: string[];
  /** The player approved remote peers running the tool's remote commands. */
  remote: boolean;
  on: boolean;
  /** The registry this instance carried the tool from; absent when it is fetched from its publisher. */
  via?: RegistryVia;
}

export const INSTALLED_KEY = "acs.tools";
export const MAX_INSTALLED = 30;
/** The installed tools must fit in this many bytes of the account's settings (the gateway keeps 16 KB in all). */
export const INSTALLED_BUDGET = 10_000;
const NAME = /^[a-z0-9][a-z0-9-]{1,39}$/;
const PUBKEY = /^[A-Za-z0-9_-]{43}$/;

/** The stored records, checked: malformed ones drop, a name appears once, at most MAX_INSTALLED. */
export function normalizeInstalled(raw: unknown): InstalledRecord[] {
  if (!Array.isArray(raw)) return [];
  const out: InstalledRecord[] = [];
  for (const x of raw) {
    if (out.length >= MAX_INSTALLED) break;
    if (!x || typeof x !== "object") continue;
    const r = x as Record<string, unknown>;
    if (typeof r.name !== "string" || !NAME.test(r.name) || out.some((o) => o.name === r.name)) continue;
    if (typeof r.url !== "string" || !/^https?:\/\//.test(r.url) || r.url.length > 500) continue;
    if (typeof r.pubkey !== "string" || !PUBKEY.test(r.pubkey)) continue;
    const grants = Array.isArray(r.grants) ? [...new Set(r.grants.filter(isCapability))] : [];
    const connect = Array.isArray(r.connect)
      ? [...new Set(r.connect.map(connectOrigin).filter((o): o is string => !!o))].slice(0, 8)
      : [];
    const via =
      r.via && typeof r.via === "object" && typeof (r.via as RegistryVia).id === "string"
        ? { id: (r.via as RegistryVia).id.slice(0, 64), account: (r.via as RegistryVia).account === true }
        : undefined;
    out.push({
      name: r.name,
      title: typeof r.title === "string" && r.title.trim() ? r.title.slice(0, 80) : r.name,
      url: r.url,
      pubkey: r.pubkey,
      grants,
      connect,
      remote: r.remote === true,
      on: r.on === true,
      ...(via ? { via } : {}),
    });
  }
  return out;
}

/** The record an approved manifest becomes. */
export function recordFor(manifest: ToolManifest, url: string, via?: RegistryVia): InstalledRecord {
  return {
    name: manifest.name,
    title: manifest.title.slice(0, 80),
    url,
    pubkey: manifest.pubkey ?? "",
    grants: [...manifest.permissions],
    connect: [...(manifest.connect ?? [])],
    remote: manifest.remote === true,
    on: true,
    ...(via ? { via } : {}),
  };
}

/**
 * What a manifest asks for beyond what the player approved in `rec`: new permissions, new `connect` origins, or
 * remote peers. Empty when it stays within the approval; otherwise the tool does not start until it is approved
 * again.
 */
export function beyondApproval(manifest: ToolManifest, rec: InstalledRecord): string[] {
  const out: string[] = manifest.permissions.filter((p) => !rec.grants.includes(p));
  for (const o of manifest.connect ?? []) if (!rec.connect.includes(o)) out.push(`network access to ${o}`);
  if (manifest.remote && !rec.remote) out.push("commands for remote peers");
  return out;
}

/** The list fits the account's settings. */
export const fitsBudget = (list: readonly InstalledRecord[]): boolean =>
  JSON.stringify(list).length <= INSTALLED_BUDGET;

/** `list` with `rec` added, or replacing the record of the same name. */
export const withRecord = (list: readonly InstalledRecord[], rec: InstalledRecord): InstalledRecord[] =>
  list.some((r) => r.name === rec.name) ? list.map((r) => (r.name === rec.name ? rec : r)) : [...list, rec];
