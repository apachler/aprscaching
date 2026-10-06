// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * attestedsites.ts — the receiving sites this instance attests for Tier A: the sites preset in
 * FIRST_PARTY_SITES, the trusted receiving stations the sysop adds in Instance admin (trusted_sites), and the
 * sites of enrolled ingest boxes the sysop trusts there (box_trusted_sites). A revoked box's sites never count,
 * and a box's sites pause while its owner (boxowner.ts) is suspended.
 * Every reader of the attested set goes through this module, so the env list and the admin switch can never
 * disagree.
 *
 * Who delivered a frame decides which of these sites it may claim ({@link sitesFor}). FIRST_PARTY_SITES and
 * trusted_sites count only for frames the shared INGEST_SECRET delivered: the instance's own ingest. A frame an
 * enrolled box delivered claims only the sites trusted through that box, so a box vouches for its own hearings
 * and for no other receiver, and no other box, nor the shared secret, can claim its site. An operator whose own
 * box signs with its key trusts that box's site under the box.
 *
 * The trusted rows are read once and kept for a short while per database binding: a batch of radio messages,
 * a find and a peer's corroboration question each cost at most one small read. A change made here drops the
 * kept copy at once; another process on the same database sees it within {@link TTL_MS}.
 */
import type { Env } from "./env.js";
import { parseAttestedSites } from "./provenance.js";
import { BOX_OWNER_SQL } from "./boxowner.js";

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
  // a box whose owner is suspended attests nothing until the suspension ends or is lifted
  const now = Math.floor(Date.now() / 1000);
  const rows = await env.DB.prepare(
    `SELECT site, NULL AS box FROM trusted_sites
     UNION ALL
     SELECT t.site, t.box_id AS box FROM box_trusted_sites t JOIN box_keys k ON k.box_id = t.box_id
      WHERE k.revoked_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM account_suspensions s
                         WHERE s.account_id = ${BOX_OWNER_SQL} AND (s.until IS NULL OR s.until > ?))
        AND NOT EXISTS (SELECT 1 FROM callsign_suspensions c
                         WHERE c.callsign = k.callsign AND (c.until IS NULL OR c.until > ?))`,
  )
    .bind(now, now)
    .all<{ site: string; box?: string | null }>();
  const trusted: Trusted = { stations: [], byBox: new Map() };
  for (const r of rows.results ?? []) {
    const site = r.site.toUpperCase();
    if (!r.box) trusted.stations.push(site);
    else trusted.byBox.set(r.box, (trusted.byBox.get(r.box) ?? new Set()).add(site));
  }
  kept.set(key, { at: Date.now(), trusted });
  return trusted;
}

/** Drop the kept copy after a trust change, so this process answers with the new set at once. */
export function forgetAttestedSites(env: Env): void {
  kept.delete(env.DB as unknown as object);
}

/** The attested sites split by who may claim them. */
export interface Attestation {
  /** FIRST_PARTY_SITES ∪ trusted_sites: claimed by frames the shared secret delivered. */
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

const NONE: ReadonlySet<string> = new Set();

/** The sites a frame delivered by `box` (null: the shared secret) may claim. */
export function sitesFor(a: Attestation, box?: string | null): Set<string> {
  return box ? (a.byBox.get(box) ?? (NONE as Set<string>)) : a.shared;
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
