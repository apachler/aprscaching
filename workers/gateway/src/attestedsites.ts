// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * attestedsites.ts — the receiving sites this instance attests for Tier A: the sites preset in
 * FIRST_PARTY_SITES, the trusted receiving stations the sysop adds in Instance admin (trusted_sites), and the
 * sites of enrolled ingest boxes the sysop trusts there (box_trusted_sites). A revoked box's sites never count.
 * Every reader of the attested set goes through this module, so the env list and the admin switch can never
 * disagree.
 *
 * Who delivered a frame decides which of these sites it may claim. FIRST_PARTY_SITES and trusted_sites are
 * the instance's own receivers: a frame naming one counts from any ingest credential. A site trusted through a
 * box counts only for frames that box delivered itself ({@link sitesFor}): a lent receiver vouches for its own
 * hearings, and no other box, nor the shared secret, can claim its site.
 *
 * The trusted rows are read once and kept for a short while per database binding: a batch of radio messages,
 * a find and a peer's corroboration question each cost at most one small read. A change made here drops the
 * kept copy at once; another isolate sees it within {@link TTL_MS}.
 */
import type { Env } from "./env.js";
import { parseAttestedSites } from "./provenance.js";

const TTL_MS = 30_000;

/** The trusted rows: the stations added by call, and each non-revoked trusted box's sites. Upper-case. */
interface Trusted {
  stations: string[];
  byBox: Map<string, Set<string>>;
}

const kept = new WeakMap<object, { at: number; trusted: Trusted }>();

async function trustedRows(env: Env): Promise<Trusted> {
  const key = env.DB as unknown as object;
  const hit = kept.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.trusted;
  const rows = await env.DB.prepare(
    `SELECT site, NULL AS box FROM trusted_sites
     UNION ALL
     SELECT t.site, t.box_id AS box FROM box_trusted_sites t JOIN box_keys k ON k.box_id = t.box_id
      WHERE k.revoked_at IS NULL`,
  ).all<{ site: string; box?: string | null }>();
  const trusted: Trusted = { stations: [], byBox: new Map() };
  for (const r of rows.results ?? []) {
    const site = r.site.toUpperCase();
    if (!r.box) trusted.stations.push(site);
    else trusted.byBox.set(r.box, (trusted.byBox.get(r.box) ?? new Set()).add(site));
  }
  kept.set(key, { at: Date.now(), trusted });
  return trusted;
}

/** Drop the kept copy after a trust change, so this isolate answers with the new set at once. */
export function forgetAttestedSites(env: Env): void {
  kept.delete(env.DB as unknown as object);
}

/** The attested sites split by who may claim them. */
export interface Attestation {
  /** FIRST_PARTY_SITES ∪ trusted_sites: claimed by any ingest credential. */
  shared: Set<string>;
  /** Each trusted box's sites: claimed only by frames that box delivered. */
  byBox: Map<string, Set<string>>;
}

export async function attestation(env: Env): Promise<Attestation> {
  const t = await trustedRows(env);
  const shared = parseAttestedSites(env.FIRST_PARTY_SITES);
  for (const s of t.stations) shared.add(s);
  return { shared, byBox: t.byBox };
}

/** The sites a frame delivered by `box` (null: the shared secret, or no box) may claim. */
export function sitesFor(a: Attestation, box?: string | null): Set<string> {
  const own = box ? a.byBox.get(box) : undefined;
  return own ? new Set([...a.shared, ...own]) : a.shared;
}

/**
 * Every site this instance attests through any credential: where a `VERIFY` message can be heard, and the
 * list the admin reads. Not for deciding one frame's attestation; that is {@link sitesFor}.
 */
export async function attestedSites(env: Env): Promise<Set<string>> {
  const a = await attestation(env);
  const all = new Set(a.shared);
  for (const sites of a.byBox.values()) for (const s of sites) all.add(s);
  return all;
}

/** Does the sysop trust this enrolled box ("Trust this station's hearings" is on for it)? */
export async function isTrustedBox(env: Env, box: string): Promise<boolean> {
  return (await trustedRows(env)).byBox.has(box);
}
