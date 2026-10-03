// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * attestedsites.ts — the receiving sites this instance attests for Tier A: the sites preset in
 * FIRST_PARTY_SITES, the trusted receiving stations the sysop adds in Instance admin (trusted_sites), and the
 * sites of enrolled ingest boxes the sysop trusts there (box_trusted_sites). A revoked box's sites never count. Every reader of the attested set goes through
 * {@link attestedSites}, so the env list and the admin switch can never disagree.
 *
 * The trusted rows are read once and kept for a short while per database binding: a batch of radio messages,
 * a find and a peer's corroboration question each cost at most one small read. A change made here drops the
 * kept copy at once; another isolate sees it within {@link TTL_MS}.
 */
import type { Env } from "./env.js";
import { parseAttestedSites } from "./provenance.js";

const TTL_MS = 30_000;
const kept = new WeakMap<object, { at: number; sites: string[] }>();

/** The sites trusted in Instance admin: added by call, or through a non-revoked box. Upper-case. */
async function trustedBoxSites(env: Env): Promise<string[]> {
  const key = env.DB as unknown as object;
  const hit = kept.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.sites;
  const rows = await env.DB.prepare(
    `SELECT site FROM trusted_sites
     UNION
     SELECT t.site FROM box_trusted_sites t JOIN box_keys k ON k.box_id = t.box_id WHERE k.revoked_at IS NULL`,
  ).all<{ site: string }>();
  const sites = (rows.results ?? []).map((r) => r.site.toUpperCase());
  kept.set(key, { at: Date.now(), sites });
  return sites;
}

/** Drop the kept copy after a trust change, so this isolate answers with the new set at once. */
export function forgetAttestedSites(env: Env): void {
  kept.delete(env.DB as unknown as object);
}

/** The effective attested-site set: FIRST_PARTY_SITES ∪ the sites trusted in Instance admin. */
export async function attestedSites(env: Env): Promise<Set<string>> {
  const sites = parseAttestedSites(env.FIRST_PARTY_SITES);
  for (const s of await trustedBoxSites(env)) sites.add(s);
  return sites;
}
