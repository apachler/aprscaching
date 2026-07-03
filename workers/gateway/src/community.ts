// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * community.ts — M4: profiles, leaderboards, badges, favorites/watches, activity feed, cache health.
 * Built on the existing tables (cache_logs, caches, achievements, favorites, watches, accounts).
 * A find counts toward stats/points only when verified; points reward distinct caches + trust tier.
 */
import type { Env } from "./env.js";
import { json } from "./app.js";
import { parsePage, keyset, paginate } from "./paging.js";
import { actor } from "./caches.js";
import { RateRequest } from "@aprsweb/shared";

const now = () => Math.floor(Date.now() / 1000);
const DAY = 86400;

// per distinct found cache: trust-tier base + difficulty + terrain (best find wins)
const POINTS =
  "(CASE l.tier WHEN 'A' THEN 10 WHEN 'B' THEN 5 ELSE 2 END) + COALESCE(c.difficulty,0) + COALESCE(c.terrain,0)";
// competitive credit requires proven control of the callsign (anti-gaming): the logger's callsign
// must be control-verified (APRS message-challenge / LoTW). Personal profiles still show all finds.
const VERIFIED_LOGGER = "AND l.logger_call IN (SELECT callsign FROM callsign_verifications WHERE status='verified')";

function periodStart(period: string | null): number {
  if (period === "month") return now() - 30 * DAY;
  if (period === "year") return now() - 365 * DAY;
  return 0;
}
function bboxClause(u: URL): { sql: string; binds: number[] } {
  const b = u.searchParams.get("bbox");
  if (!b) return { sql: "", binds: [] };
  const p = b.split(",").map(Number);
  if (p.length < 4 || p.some(Number.isNaN)) return { sql: "", binds: [] };
  const [minLon, minLat, maxLon, maxLat] = p as [number, number, number, number];
  return { sql: " AND c.lat BETWEEN ? AND ? AND c.lon BETWEEN ? AND ?", binds: [minLat, maxLat, minLon, maxLon] };
}

// ---------------------------------------------------------------- leaderboard
export async function handleLeaderboard(req: Request, env: Env): Promise<Response> {
  const u = new URL(req.url);
  const metric = u.searchParams.get("metric") === "finds" ? "finds" : "points";
  const since = periodStart(u.searchParams.get("period"));
  const bb = bboxClause(u);
  const limit = Math.min(Math.max(Number(u.searchParams.get("limit") ?? 100) || 100, 1), 500);

  const rows = (
    await env.DB.prepare(
      `SELECT logger_call AS loggerCall, SUM(pts) AS points, COUNT(*) AS finds FROM (
       SELECT l.logger_call, l.cache_id, MAX(${POINTS}) AS pts
       FROM cache_logs l JOIN caches c ON c.id = l.cache_id
       WHERE l.log_type='found' AND l.verified=1 AND l.ts >= ? ${VERIFIED_LOGGER}${bb.sql}
       GROUP BY l.logger_call, l.cache_id
     ) GROUP BY logger_call ORDER BY ${metric === "finds" ? "finds" : "points"} DESC, finds DESC LIMIT ?`,
    )
      .bind(since, ...bb.binds, limit)
      .all<{ loggerCall: string; points: number; finds: number }>()
  ).results;

  return json({
    metric,
    period: u.searchParams.get("period") ?? "all",
    leaderboard: rows.map((r, i) => ({ rank: i + 1, ...r, points: Math.round(r.points) })),
  });
}

// ---------------------------------------------------------------- profile
export async function handleProfile(req: Request, env: Env, callsign: string): Promise<Response> {
  const cs = callsign.toUpperCase();
  const stat = await env.DB.prepare(
    `SELECT COUNT(*) AS finds, COALESCE(SUM(pts),0) AS points, MIN(firstTs) AS firstFind, MAX(lastTs) AS lastFind FROM (
       SELECT l.cache_id, MAX(${POINTS}) AS pts, MIN(l.ts) AS firstTs, MAX(l.ts) AS lastTs
       FROM cache_logs l JOIN caches c ON c.id = l.cache_id
       WHERE l.logger_call=? AND l.log_type='found' AND l.verified=1 GROUP BY l.cache_id)`,
  )
    .bind(cs)
    .first<{ finds: number; points: number; firstFind: number | null; lastFind: number | null }>();

  const byTier = (
    await env.DB.prepare(
      "SELECT tier, COUNT(*) AS n FROM cache_logs WHERE logger_call=? AND log_type='found' AND verified=1 GROUP BY tier",
    )
      .bind(cs)
      .all<{ tier: string | null; n: number }>()
  ).results;
  const byType = (
    await env.DB.prepare(
      `SELECT c.type, COUNT(DISTINCT l.cache_id) AS n FROM cache_logs l JOIN caches c ON c.id=l.cache_id
      WHERE l.logger_call=? AND l.log_type='found' AND l.verified=1 GROUP BY c.type`,
    )
      .bind(cs)
      .all<{ type: string; n: number }>()
  ).results;
  const hides = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM caches WHERE owner_call=? AND source='native' AND status!='archived'",
  )
    .bind(cs)
    .first<{ n: number }>();
  // "Infrastructure" contribution: Tier-A finds this operator's IGate(s) helped corroborate — locally
  // or, via a revealing peer, on another instance (cross-instance credit +).
  const corr = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM cache_logs l
      WHERE l.tier='A' AND l.verified=1 AND (l.corroborator_igate = ? OR l.corroborator_igate LIKE ?)`,
  )
    .bind(cs, `${cs}-%`)
    .first<{ n: number }>();
  const badges = (
    await env.DB.prepare("SELECT badge, earned_at AS earnedAt FROM achievements WHERE callsign=? ORDER BY earned_at")
      .bind(cs)
      .all<{ badge: string; earnedAt: number }>()
  ).results;
  const acct = await env.DB.prepare(
    `SELECT verified, tier, display_name AS displayName, home_grid AS homeGrid, avatar_url AS avatarUrl,
            bio, links, public_contact AS publicContact, profile_public AS profilePublic
       FROM accounts WHERE callsign=?`,
  )
    .bind(cs)
    .first<{
      verified: number;
      tier: string | null;
      displayName: string | null;
      homeGrid: string | null;
      avatarUrl: string | null;
      bio: string | null;
      links: string | null;
      publicContact: string | null;
      profilePublic: number;
    }>();

  // opt-in profile: surfaced only when the master switch is on; empty fields omitted
  let profile: Record<string, unknown> | undefined;
  if (acct && (acct.profilePublic ?? 1) === 1) {
    const links = acct.links ? (JSON.parse(acct.links) as unknown[]) : [];
    const p: Record<string, unknown> = {};
    if (acct.displayName) p.displayName = acct.displayName;
    if (acct.homeGrid) p.homeGrid = acct.homeGrid;
    if (acct.avatarUrl) p.avatarUrl = acct.avatarUrl;
    if (acct.bio) p.bio = acct.bio;
    if (links.length) p.links = links;
    if (acct.publicContact) p.publicContact = acct.publicContact;
    if (Object.keys(p).length) profile = p;
  }

  return json({
    callsign: cs,
    homeInstance: env.INSTANCE, // where this operator is homed
    accountVerified: (acct?.verified ?? 0) === 1,
    supporter: acct?.tier === "supporter", // recognition only; never gates anything
    finds: stat?.finds ?? 0,
    points: Math.round(stat?.points ?? 0),
    firstFind: stat?.firstFind ?? null,
    lastFind: stat?.lastFind ?? null,
    hides: hides?.n ?? 0,
    corroborations: corr?.n ?? 0,
    byTier: Object.fromEntries(byTier.map((r) => [r.tier ?? "?", r.n])),
    byType: Object.fromEntries(byType.map((r) => [r.type, r.n])),
    badges,
    ...(profile ? { profile } : {}),
  });
}

// ---------------------------------------------------------------- corroborator leaderboard
// Rank the IGates that helped verify finds to Tier A — the gating IGate on each verified RF find.
// Running infrastructure becomes a visible contribution to the commons.
export async function handleCorroborators(req: Request, env: Env): Promise<Response> {
  const u = new URL(req.url);
  const since = periodStart(u.searchParams.get("period"));
  const bb = bboxClause(u);
  const limit = Math.min(Math.max(Number(u.searchParams.get("limit") ?? 50) || 50, 1), 200);
  // Credit the IGate stored on each Tier-A find — local OR a federated peer's revealed IGate
  // (cross-instance corroborator credit +).
  const rows = (
    await env.DB.prepare(
      `SELECT l.corroborator_igate AS igate, COUNT(*) AS corroborations
       FROM cache_logs l JOIN caches c ON c.id = l.cache_id
      WHERE l.tier='A' AND l.verified=1 AND l.corroborator_igate IS NOT NULL AND l.ts >= ?${bb.sql}
      GROUP BY l.corroborator_igate ORDER BY corroborations DESC, igate ASC LIMIT ?`,
    )
      .bind(since, ...bb.binds, limit)
      .all<{ igate: string; corroborations: number }>()
  ).results;
  return json({
    period: u.searchParams.get("period") ?? "all",
    corroborators: rows.map((r, i) => ({ rank: i + 1, ...r })),
  });
}

// ---------------------------------------------------------------- activity feed
export async function handleActivity(req: Request, env: Env): Promise<Response> {
  const u = new URL(req.url);
  const bb = bboxClause(u);
  const pg = parsePage(u, 50, 200);
  const ks = keyset(pg.cursor, "l.ts", "l.id");
  const rows = (
    await env.DB.prepare(
      `SELECT l.id, l.logger_call AS loggerCall, l.ts, l.log_type AS logType, l.verified, l.tier,
            c.id AS cacheId, c.code AS cacheCode, c.title AS cacheTitle
       FROM cache_logs l JOIN caches c ON c.id = l.cache_id
       WHERE 1=1${bb.sql}${ks.sql} ORDER BY l.ts DESC, l.id DESC LIMIT ?`,
    )
      .bind(...bb.binds, ...ks.binds, pg.limit + 1)
      .all()
  ).results as any[];
  const page = paginate(rows, pg.limit, (r) => ({ primary: r.ts, id: r.id }));
  return json({
    activity: page.items.map((r: any) => ({ ...r, verified: r.verified === 1 })),
    nextCursor: page.nextCursor,
    hasMore: page.hasMore,
  });
}

// ---------------------------------------------------------------- favorites / watches
async function toggleSet(
  env: Env,
  table: "favorites" | "watches",
  cacheId: number,
  callsign: string,
  on?: boolean,
): Promise<{ on: boolean; count: number }> {
  const cs = callsign.toUpperCase();
  const exists = await env.DB.prepare(`SELECT 1 AS x FROM ${table} WHERE callsign=? AND cache_id=?`)
    .bind(cs, cacheId)
    .first();
  const want = on ?? !exists;
  if (want && !exists)
    await env.DB.prepare(`INSERT OR IGNORE INTO ${table} (callsign, cache_id) VALUES (?,?)`).bind(cs, cacheId).run();
  if (!want && exists)
    await env.DB.prepare(`DELETE FROM ${table} WHERE callsign=? AND cache_id=?`).bind(cs, cacheId).run();
  const count = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE cache_id=?`)
    .bind(cacheId)
    .first<{ n: number }>();
  return { on: want, count: count?.n ?? 0 };
}
export async function handleFavorite(req: Request, env: Env, cacheId: number): Promise<Response> {
  const b = (await req.json().catch(() => ({}))) as { callsign?: string; on?: boolean };
  if (!b.callsign) return json({ error: "callsign required" }, { status: 400 });
  return json(await toggleSet(env, "favorites", cacheId, b.callsign, b.on));
}
export async function handleWatch(req: Request, env: Env, cacheId: number): Promise<Response> {
  const b = (await req.json().catch(() => ({}))) as { callsign?: string; on?: boolean };
  if (!b.callsign) return json({ error: "callsign required" }, { status: 400 });
  return json(await toggleSet(env, "watches", cacheId, b.callsign, b.on));
}

// ---------------------------------------------------------------- helpers for cache detail
export async function cacheHealth(
  env: Env,
  cacheId: number,
): Promise<{ needsMaintenance: boolean; dnfStreak: number; lastFound: number | null }> {
  const recent = (
    await env.DB.prepare(
      "SELECT log_type, ts, verified FROM cache_logs WHERE cache_id=? AND log_type IN ('found','dnf') ORDER BY ts DESC LIMIT 10",
    )
      .bind(cacheId)
      .all<{ log_type: string; ts: number; verified: number }>()
  ).results;
  let dnfStreak = 0;
  for (const r of recent) {
    if (r.log_type === "dnf") dnfStreak++;
    else break;
  }
  const lf = await env.DB.prepare("SELECT MAX(ts) AS ts FROM cache_logs WHERE cache_id=? AND log_type='found'")
    .bind(cacheId)
    .first<{ ts: number | null }>();
  return { needsMaintenance: dnfStreak >= 3, dnfStreak, lastFound: lf?.ts ?? null };
}
// ---------------------------------------------------------------- rating (F-6, owner-gated)
type RatingPolicy = "finders" | "all" | "off";

/** True if `callsign` is permitted to rate this cache under its policy (a verified finder, or anyone). */
async function mayRate(env: Env, cacheId: number, policy: RatingPolicy, callsign: string): Promise<boolean> {
  if (policy === "off") return false;
  if (policy === "all") return true;
  const found = await env.DB.prepare(
    "SELECT 1 AS x FROM cache_logs WHERE cache_id=? AND logger_call=? AND log_type='found' AND verified=1 LIMIT 1",
  )
    .bind(cacheId, callsign.toUpperCase())
    .first();
  return !!found;
}

/** Aggregate rating for the cache detail: average, count, the caller's own star, the policy + can-rate. */
export async function ratingInfo(
  env: Env,
  cacheId: number,
  policy: RatingPolicy,
  callsign?: string | null,
): Promise<{ avg: number | null; count: number; mine: number | null; policy: RatingPolicy; canRate: boolean }> {
  const agg = await env.DB.prepare("SELECT AVG(stars) AS avg, COUNT(*) AS n FROM cache_ratings WHERE cache_id=?")
    .bind(cacheId)
    .first<{ avg: number | null; n: number }>();
  let mine: number | null = null,
    canRate = false;
  if (callsign) {
    const cs = callsign.toUpperCase();
    const r = await env.DB.prepare("SELECT stars FROM cache_ratings WHERE cache_id=? AND callsign=?")
      .bind(cacheId, cs)
      .first<{ stars: number }>();
    mine = r?.stars ?? null;
    canRate = await mayRate(env, cacheId, policy, cs);
  }
  return { avg: agg?.avg ?? null, count: agg?.n ?? 0, mine, policy, canRate };
}

export async function handleRate(req: Request, env: Env, cacheId: number): Promise<Response> {
  const parsed = RateRequest.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return json({ error: "stars must be 1–5", issues: parsed.error.issues }, { status: 400 });
  const who = await actor(req, env, parsed.data.callsign);
  if (!who) return json({ error: "sign in or pass callsign to rate" }, { status: 401 });
  const cache = await env.DB.prepare("SELECT rating_policy FROM caches WHERE id=?")
    .bind(cacheId)
    .first<{ rating_policy: string }>();
  if (!cache) return json({ error: "no such cache" }, { status: 404 });
  const policy = (cache.rating_policy ?? "finders") as RatingPolicy;
  if (!(await mayRate(env, cacheId, policy, who)))
    return json(
      { error: policy === "off" ? "rating is disabled for this cache" : "only finders may rate this cache" },
      { status: 403 },
    );
  await env.DB.prepare(
    `INSERT INTO cache_ratings (cache_id, callsign, stars, ts) VALUES (?,?,?,?)
     ON CONFLICT(cache_id, callsign) DO UPDATE SET stars=excluded.stars, ts=excluded.ts`,
  )
    .bind(cacheId, who, parsed.data.stars, Math.floor(Date.now() / 1000))
    .run();
  return json({ rating: await ratingInfo(env, cacheId, policy, who) });
}

export async function favoritesInfo(
  env: Env,
  cacheId: number,
  callsign?: string | null,
): Promise<{ favorites: number; favorited: boolean }> {
  const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM favorites WHERE cache_id=?")
    .bind(cacheId)
    .first<{ n: number }>();
  let favorited = false;
  if (callsign)
    favorited = !!(await env.DB.prepare("SELECT 1 AS x FROM favorites WHERE cache_id=? AND callsign=?")
      .bind(cacheId, callsign.toUpperCase())
      .first());
  return { favorites: count?.n ?? 0, favorited };
}

// ---------------------------------------------------------------- badges (awarded after a find / hide)
const FIND_BADGES: { badge: string; min: number }[] = [
  { badge: "first-find", min: 1 },
  { badge: "finder-10", min: 10 },
  { badge: "finder-50", min: 50 },
  { badge: "finder-100", min: 100 },
  { badge: "finder-500", min: 500 },
];
const TYPE_BADGE: Record<string, string> = {
  sota: "summiteer",
  pota: "park-hunter",
  aprs_living: "rover-hunter",
  wwff: "flora-fauna",
  castle: "castle-hunter",
  bunker: "bunker-hunter",
};

export async function awardFindBadges(env: Env, callsign: string): Promise<void> {
  const cs = callsign.toUpperCase();
  const grant = (badge: string) =>
    env.DB.prepare("INSERT OR IGNORE INTO achievements (callsign, badge, earned_at) VALUES (?,?,?)").bind(
      cs,
      badge,
      now(),
    );
  const stmts = [];
  const finds =
    (
      await env.DB.prepare(
        "SELECT COUNT(DISTINCT cache_id) AS n FROM cache_logs WHERE logger_call=? AND log_type='found' AND verified=1",
      )
        .bind(cs)
        .first<{ n: number }>()
    )?.n ?? 0;
  for (const b of FIND_BADGES) if (finds >= b.min) stmts.push(grant(b.badge));
  if (
    await env.DB.prepare(
      "SELECT 1 AS x FROM cache_logs WHERE logger_call=? AND log_type='found' AND verified=1 AND tier='A' LIMIT 1",
    )
      .bind(cs)
      .first()
  )
    stmts.push(grant("rf-verified"));
  const types = (
    await env.DB.prepare(
      "SELECT DISTINCT c.type FROM cache_logs l JOIN caches c ON c.id=l.cache_id WHERE l.logger_call=? AND l.log_type='found' AND l.verified=1",
    )
      .bind(cs)
      .all<{ type: string }>()
  ).results;
  for (const t of types) if (TYPE_BADGE[t.type]) stmts.push(grant(TYPE_BADGE[t.type]!));
  if (stmts.length) await env.DB.batch(stmts);
}
export async function awardHideBadge(env: Env, callsign: string): Promise<void> {
  const cs = callsign.toUpperCase();
  const hides =
    (
      await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM caches WHERE owner_call=? AND source='native' AND status!='archived'",
      )
        .bind(cs)
        .first<{ n: number }>()
    )?.n ?? 0;
  const grant = (badge: string) =>
    env.DB.prepare("INSERT OR IGNORE INTO achievements (callsign, badge, earned_at) VALUES (?,?,?)").bind(
      cs,
      badge,
      now(),
    );
  const stmts = [];
  if (hides >= 1) stmts.push(grant("hider"));
  if (hides >= 5) stmts.push(grant("cache-architect"));
  if (hides >= 20) stmts.push(grant("cache-master"));
  if (stmts.length) await env.DB.batch(stmts);
}
