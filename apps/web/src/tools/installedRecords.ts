// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * installedRecords.ts — the record of a player's installed tools as settings keep it (localStorage `acs.tools`,
 * synced to the account): its shape and the check every stored or synced list passes. Pure, so tests share it.
 */
import { isCapability, type Capability } from "@aprscaching/tools";
import type { RegistryVia } from "./registries.js";

/** One installed tool as the player's settings keep it. */
export interface InstalledRecord {
  name: string;
  /** The manifest's upstream address. */
  url: string;
  /** The author key the manifest was signed with when the player approved it. */
  pubkey: string;
  /** The permissions the player approved. */
  grants: Capability[];
  on: boolean;
  /** The registry this instance carried the tool from; absent when it is fetched from its publisher. */
  via?: RegistryVia;
}

export const INSTALLED_KEY = "acs.tools";
export const MAX_INSTALLED = 40;
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
    const via =
      r.via && typeof r.via === "object" && typeof (r.via as RegistryVia).id === "string"
        ? { id: (r.via as RegistryVia).id.slice(0, 64), account: (r.via as RegistryVia).account === true }
        : undefined;
    out.push({ name: r.name, url: r.url, pubkey: r.pubkey, grants, on: r.on === true, ...(via ? { via } : {}) });
  }
  return out;
}

/** `list` with `rec` added, or replacing the record of the same name. */
export const withRecord = (list: readonly InstalledRecord[], rec: InstalledRecord): InstalledRecord[] =>
  list.some((r) => r.name === rec.name) ? list.map((r) => (r.name === rec.name ? rec : r)) : [...list, rec];
