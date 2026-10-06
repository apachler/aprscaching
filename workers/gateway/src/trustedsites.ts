// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * trustedsites.ts — the trusted receiving stations of Instance admin. A trusted station's direct hearings
 * count for Tier A (attestedsites.ts). The list has three sources:
 *   - config: a site preset in FIRST_PARTY_SITES — shown, never changed from here;
 *   - admin:  a site the sysop adds by its call, such as their own box on the shared INGEST_SECRET;
 *   - box:    a site of an enrolled box the sysop trusts ("Trust this station's hearings", boxkeys.ts).
 *
 *   GET    /api/admin/sites               every trusted station, with its source and trusted since / by (sysop)
 *   POST   /api/admin/sites               add a station {site} (sysop)
 *   DELETE /api/admin/sites/:site         remove a station the sysop added (sysop)
 *   GET    /api/admin/sites/:site/finds   the finds the station verified (sysop)
 *
 * Every route is sysop-gated here, never only hidden in the app.
 */
import { baseCall } from "@aprscaching/aprs";
import { SITE_CALL_RE } from "@aprscaching/shared";
import type { Env } from "./env.js";
import { json } from "./http.js";
import { requireSysop } from "./admin.js";
import { sessionIdentity } from "./auth.js";
import { nowS } from "./util/time.js";
import { parseAttestedSites } from "./provenance.js";
import { forgetAttestedSites } from "./attestedsites.js";

/** The most recent verified finds shown per trusted station. */
const RECENT_FINDS = 10;

export interface TrustedStation {
  site: string;
  source: "config" | "admin" | "box";
  box?: string;
  boxLabel?: string | null;
  trustedBy: string | null;
  trustedByCall: string | null;
  trustedAt: number | null;
}

/**
 * The finds verified at Tier A on this instance by a hearing at one of `sites`, each counted from its own
 * `since` (null: always): the count and the most recent few. A find records the site whose hearing verified it
 * (cache_logs.corroborator_igate); a find a peer instance corroborated is not counted, since no hearing here
 * verified it.
 */
export async function verifiedFinds(env: Env, sites: { site: string; since: number | null }[]) {
  if (sites.length === 0)
    return { count: 0, recent: [] as { code: string; loggerCall: string; ts: number; site: string }[] };
  const bySite = sites.map(() => "(l.corroborator_igate = ? AND COALESCE(l.received_at, l.ts) >= ?)").join(" OR ");
  const binds = sites.flatMap((s) => [s.site, s.since ?? 0]);
  const where = `l.log_type = 'found' AND l.tier = 'A' AND l.verified = 1 AND l.verify_method = 'aprs_rf'
      AND l.corroborated_by IS NULL AND (${bySite})`;
  const count = await env.DB.prepare(`SELECT COUNT(*) AS n FROM cache_logs l WHERE ${where}`)
    .bind(...binds)
    .first<{ n: number }>();
  const recent = await env.DB.prepare(
    `SELECT c.code, l.logger_call AS loggerCall, l.ts, l.corroborator_igate AS site
       FROM cache_logs l JOIN caches c ON c.id = l.cache_id
      WHERE ${where} ORDER BY l.ts DESC LIMIT ${RECENT_FINDS}`,
  )
    .bind(...binds)
    .all<{ code: string; loggerCall: string; ts: number; site: string }>();
  return { count: count?.n ?? 0, recent: recent.results ?? [] };
}

/** Every trusted station, config first, then by site call. */
async function trustedStations(env: Env): Promise<TrustedStation[]> {
  const config: TrustedStation[] = [...parseAttestedSites(env.FIRST_PARTY_SITES)].map((site) => ({
    site,
    source: "config",
    trustedBy: null,
    trustedByCall: null,
    trustedAt: null,
  }));
  const rows = await env.DB.prepare(
    `SELECT site, 'admin' AS source, NULL AS box, NULL AS boxLabel, trusted_by AS trustedBy, trusted_at AS trustedAt,
            (SELECT a.callsign FROM accounts a WHERE a.account_id = trusted_by LIMIT 1) AS trustedByCall
       FROM trusted_sites
     UNION ALL
     SELECT t.site, 'box', t.box_id, k.label, t.trusted_by, t.trusted_at,
            (SELECT a.callsign FROM accounts a WHERE a.account_id = t.trusted_by LIMIT 1)
       FROM box_trusted_sites t JOIN box_keys k ON k.box_id = t.box_id WHERE k.revoked_at IS NULL
     ORDER BY 1`,
  ).all<TrustedStation & { box: string | null }>();
  const db = (rows.results ?? []).map(({ box, boxLabel, ...r }) => ({
    ...r,
    ...(box ? { box, boxLabel } : {}),
    trustedByCall: r.trustedByCall ? baseCall(r.trustedByCall) : null,
  }));
  return [...config, ...db];
}

/** GET /api/admin/sites — every trusted receiving station and where its trust comes from. */
export async function handleListSites(req: Request, env: Env): Promise<Response> {
  const denied = await requireSysop(req, env, { allowOperatorSecret: true });
  if (denied) return denied;
  return json({ sites: await trustedStations(env) });
}

/** POST /api/admin/sites {site} — trust a receiving station by its call. */
export async function handleAddSite(req: Request, env: Env): Promise<Response> {
  const denied = await requireSysop(req, env, { allowOperatorSecret: true });
  if (denied) return denied;
  const b = ((await req.json().catch(() => ({}))) ?? {}) as { site?: unknown };
  const site = typeof b.site === "string" ? b.site.trim().toUpperCase() : "";
  if (!SITE_CALL_RE.test(site)) return json({ error: "enter the station's call, such as OE8ABC-10" }, { status: 400 });
  if (parseAttestedSites(env.FIRST_PARTY_SITES).has(site))
    return json({ error: `${site} is set in configuration (FIRST_PARTY_SITES)` }, { status: 409 });
  const who = (await sessionIdentity(req, env))?.accountId ?? "operator";
  await env.DB.prepare("INSERT OR IGNORE INTO trusted_sites (site, trusted_by, trusted_at) VALUES (?,?,?)")
    .bind(site, who, nowS())
    .run();
  forgetAttestedSites(env);
  console.log(`receiving site ${site} trusted by ${who}`);
  return json(
    { site: (await trustedStations(env)).find((s) => s.source === "admin" && s.site === site) },
    { status: 201 },
  );
}

/** DELETE /api/admin/sites/:site — stop trusting a station the sysop added here. */
export async function handleRemoveSite(req: Request, env: Env, rawSite: string): Promise<Response> {
  const denied = await requireSysop(req, env, { allowOperatorSecret: true });
  if (denied) return denied;
  const site = decodeURIComponent(rawSite).toUpperCase();
  const r = await env.DB.prepare("DELETE FROM trusted_sites WHERE site = ?").bind(site).run();
  if (!r.meta?.changes) {
    const why = parseAttestedSites(env.FIRST_PARTY_SITES).has(site)
      ? `${site} is set in configuration: remove it from FIRST_PARTY_SITES`
      : `${site} is not on the list, or it is trusted through its enrolled box`;
    return json({ error: why }, { status: 404 });
  }
  forgetAttestedSites(env);
  return json({ site, removed: true });
}

/** GET /api/admin/sites/:site/finds — the finds a trusted station verified since it was trusted. */
export async function handleSiteFinds(req: Request, env: Env, rawSite: string): Promise<Response> {
  const denied = await requireSysop(req, env, { allowOperatorSecret: true });
  if (denied) return denied;
  const site = decodeURIComponent(rawSite).toUpperCase();
  const entries = (await trustedStations(env)).filter((s) => s.site === site);
  if (entries.length === 0) return json({ error: `${site} is not a trusted station` }, { status: 404 });
  // a site trusted from several sources counts from its earliest trust; a preset site counts always
  const since = entries.some((e) => e.trustedAt == null) ? null : Math.min(...entries.map((e) => e.trustedAt!));
  return json({ site, stations: entries, ...(await verifiedFinds(env, [{ site, since }])) });
}
