// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * adoption.ts — handing a native cache to a new owner.
 *
 * A cache whose owner erased their account is archived and owned by a withdrawn marker, so nobody can
 * edit it; an abandoned cache has an owner who no longer looks after it. The sysop can put either up
 * for adoption with a public note, and the community asks for it:
 *
 *  - **Offer** (sysop): the cache is listed at `GET /api/adoptions`. An active owner is told (an alert and
 *    the offer on the cache page) and can keep the cache by declining the offer. A cache with an active
 *    owner cannot change hands until the offer has stood for {@link ADOPTION_NOTICE_SEC}; a withdrawn
 *    owner has nobody to notify, so there is no notice period.
 *  - **Request** (community): a signed-in holder of a control-verified call asks for the cache, saying
 *    whether they have checked that the container is in place. Requests wait for the sysop — first come
 *    would let the quickest account grab any cache, so a person decides.
 *  - **Approve / decline** (sysop): approval hands the cache to the requester's call and declines the
 *    other requests. **Assign** (sysop) hands it straight to a named call.
 *
 * Every hand-over re-checks that the new owner's account holds the call and that the call is
 * control-verified, so ownership follows a licence the account has proven, never a bare call string.
 * A hand-over changes only `owner_call` (and the status, when the cache is confirmed in place): finds,
 * logs, media and history stay with the cache. `updated_at` moves forward, so the caches feed carries
 * the new owner to every peer. Each step is written to `cache_adoptions`.
 */
import { nowS } from "./util/time.js";
import type { Env } from "./env.js";
import type { SqlStatement } from "./runtime.js";
import { baseCall } from "@aprscaching/aprs";
import { json } from "./http.js";
import { sessionIdentity, accountHoldsCall, baseHolder, mayActAsOwner, isWithdrawnCall, displayCall } from "./auth.js";
import { isCallsignVerified } from "./callsign.js";
import { requireSysop } from "./admin.js";
import { pushAlert } from "./notify.js";

/** How long an offer on a cache with an active owner stands before the cache may change hands: time for
 *  the owner to see the alert and keep their cache. */
export const ADOPTION_NOTICE_SEC = 14 * 86_400;

const NOTE_MIN = 3;
const NOTE_MAX = 300;
const CALL_RE = /^[A-Z0-9]{3,9}(-[A-Z0-9]{1,2})?$/;

interface CacheLite {
  id: number;
  code: string;
  title: string;
  type: string;
  status: string;
  lat: number | null;
  lon: number | null;
  owner_call: string;
  source: string;
}
interface OfferRow {
  cache_id: number;
  offered_by: string;
  note: string;
  offered_at: number;
}
interface RequestRow {
  id: number;
  cache_id: number;
  account_id: string;
  callsign: string;
  in_place: number;
  note: string | null;
  status: string;
  requested_at: number;
  decided_at: number | null;
}

const CACHE_COLS = "c.id, c.code, c.title, c.type, c.status, c.lat, c.lon, c.owner_call, c.source";

/** A cache that can still change hands: a moderator-removed cache is out of the adoption flow entirely. */
async function loadCache(env: Env, id: number): Promise<CacheLite | null> {
  return env.DB.prepare(`SELECT ${CACHE_COLS} FROM caches c WHERE c.id=? AND c.removed_at IS NULL`)
    .bind(id)
    .first<CacheLite>();
}
async function loadOffer(env: Env, cacheId: number): Promise<OfferRow | null> {
  return env.DB.prepare("SELECT * FROM cache_adoption_offers WHERE cache_id=?").bind(cacheId).first<OfferRow>();
}

/** When an offer on this cache lets it change hands: at once for a withdrawn owner, after the notice
 *  period for an active one. */
const noticeEndsAt = (c: CacheLite, offeredAt: number): number =>
  isWithdrawnCall(c.owner_call) ? offeredAt : offeredAt + ADOPTION_NOTICE_SEC;

/** A cache as served to readers: the owner through `displayCall`, so an erasure suffix never leaves. */
const cacheOut = (c: CacheLite) => ({
  id: c.id,
  code: c.code,
  title: c.title,
  type: c.type,
  status: c.status,
  lat: c.lat,
  lon: c.lon,
  ownerCall: displayCall(c.owner_call),
  ownerWithdrawn: isWithdrawnCall(c.owner_call),
});

/** The note from a request body: trimmed, bounded, and required when `required`. A string is an error. */
function noteOf(v: unknown, required: boolean): { note: string | null } | { error: string } {
  const s = typeof v === "string" ? v.trim() : "";
  if (!s) return required ? { error: `a note of ${NOTE_MIN}–${NOTE_MAX} characters is required` } : { note: null };
  if (s.length < NOTE_MIN || s.length > NOTE_MAX)
    return { error: `the note must be ${NOTE_MIN}–${NOTE_MAX} characters` };
  return { note: s };
}

function audit(
  env: Env,
  cacheId: number,
  action: string,
  actor: string,
  f: { from?: string | null; to?: string | null; note?: string | null } = {},
): SqlStatement {
  return env.DB.prepare(
    "INSERT INTO cache_adoptions (cache_id, action, actor_call, from_call, to_call, note, at) VALUES (?,?,?,?,?,?,?)",
  ).bind(cacheId, action, actor, f.from ?? null, f.to ?? null, f.note ?? null, nowS());
}

/** Tell an account something about a cache, in its alert list and by push. */
async function alertAccount(env: Env, accountId: string | null, c: CacheLite, kind: string, detail: string) {
  // a held call on an account that has no account id yet resolves to a `callsign:` stand-in: nobody to alert
  if (!accountId || accountId.startsWith("callsign:")) return;
  await env.DB.prepare(
    "INSERT INTO watch_alerts (account_id, callsign, kind, detail, cache_id, lat, lon, ts) VALUES (?,?,?,?,?,?,?,?)",
  )
    .bind(accountId, c.code, kind, detail, c.id, c.lat, c.lon, nowS())
    .run();
  await pushAlert(env, accountId);
}

/** The owner's account, for a cache whose owner is a person (not a withdrawn marker). */
const ownerAccount = async (env: Env, c: CacheLite) =>
  isWithdrawnCall(c.owner_call) ? null : baseHolder(env, baseCall(c.owner_call));

/** The sysop's base call: the caller has passed requireSysop, so the session resolves. */
const sysopCall = async (req: Request, env: Env) => baseCall((await sessionIdentity(req, env))!.callsign);

/** Can the holder of `callsign` on `accountId` own a cache: the account holds the call and it is verified? */
async function eligibleOwner(env: Env, accountId: string, callsign: string): Promise<boolean> {
  return (await accountHoldsCall(env, accountId, callsign)) && (await isCallsignVerified(env, baseCall(callsign)));
}

/**
 * Move a cache to `to`. The owner must still be the one the caller read, so two hand-overs racing on one
 * cache change it once. `updated_at` moves strictly forward, so the caches feed re-serves the row to peers
 * even within the second of an earlier edit. Returns false when the owner changed underneath.
 */
async function handOver(
  env: Env,
  c: CacheLite,
  to: string,
  activate: boolean,
  after: SqlStatement[],
): Promise<boolean> {
  const moved = await env.DB.prepare(
    `UPDATE caches SET owner_call=?, status=CASE WHEN ?=1 THEN 'active' ELSE status END,
       updated_at=MAX(updated_at + 1, ?) WHERE id=? AND owner_call=? AND removed_at IS NULL`,
  )
    .bind(to, activate ? 1 : 0, nowS(), c.id, c.owner_call)
    .run();
  if ((moved.meta?.changes ?? 0) !== 1) return false;
  await env.DB.batch([env.DB.prepare("DELETE FROM cache_adoption_offers WHERE cache_id=?").bind(c.id), ...after]);
  return true;
}

/** Pending requests on a cache, decided `status` by `by` — the ones a hand-over or withdrawal leaves behind. */
async function settlePending(env: Env, cacheId: number, status: "declined" | "cancelled", by: string) {
  const pending = (
    await env.DB.prepare("SELECT * FROM cache_adoption_requests WHERE cache_id=? AND status='pending'")
      .bind(cacheId)
      .all<RequestRow>()
  ).results;
  const stmt = env.DB.prepare(
    "UPDATE cache_adoption_requests SET status=?, decided_at=?, decided_by=? WHERE cache_id=? AND status='pending'",
  ).bind(status, nowS(), by, cacheId);
  return { pending, stmt };
}

async function tellDeclined(env: Env, c: CacheLite, rows: RequestRow[]) {
  for (const r of rows)
    await alertAccount(env, r.account_id, c, "adoption_declined", `Your request to adopt ${c.code} was not taken up`);
}

// ---------------------------------------------------------------- public + community

/** GET /api/adoptions — every cache currently up for adoption, newest offer first. */
export async function handleAdoptionList(env: Env): Promise<Response> {
  const rows = (
    await env.DB.prepare(
      `SELECT ${CACHE_COLS}, o.note, o.offered_at FROM cache_adoption_offers o JOIN caches c ON c.id = o.cache_id
        WHERE c.source = 'native' AND c.removed_at IS NULL ORDER BY o.offered_at DESC, c.id DESC LIMIT 500`,
    ).all<CacheLite & { note: string; offered_at: number }>()
  ).results;
  return json({
    adoptions: rows.map((r) => ({
      ...cacheOut(r),
      cacheId: r.id,
      note: r.note,
      offeredAt: r.offered_at,
      noticeEndsAt: noticeEndsAt(r, r.offered_at),
    })),
  });
}

/** The signed-in person as a would-be adopter, or why they cannot adopt. */
async function adopter(
  req: Request,
  env: Env,
): Promise<{ accountId: string; callsign: string; verified: boolean } | null> {
  const me = await sessionIdentity(req, env);
  if (!me || isWithdrawnCall(me.callsign)) return null;
  const callsign = me.callsign.toUpperCase();
  return { accountId: me.accountId, callsign, verified: await eligibleOwner(env, me.accountId, callsign) };
}

/**
 * /api/caches/:id/adoption — `GET` the offer on a cache and the caller's own request; `POST {inPlace, note?}`
 * asks to adopt it; `DELETE` is the owner keeping the cache (declining the offer). `/request` + `DELETE`
 * withdraws the caller's own pending request.
 */
export async function handleCacheAdoption(
  req: Request,
  env: Env,
  id: number,
  sub: "request" | null,
): Promise<Response> {
  const c = await loadCache(env, id);
  if (!c) return json({ error: "no such cache" }, { status: 404 });
  const m = req.method;
  if (sub === "request") {
    if (m !== "DELETE") return new Response("method not allowed", { status: 405 });
    return cancelRequest(req, env, c);
  }
  if (m === "GET") return adoptionState(req, env, c);
  if (m === "POST") return requestAdoption(req, env, c);
  if (m === "DELETE") return ownerDeclines(req, env, c);
  return new Response("method not allowed", { status: 405 });
}

/** Does the signed-in session's account hold the owner call's licence? A withdrawn owner has none. */
const isOwner = (req: Request, env: Env, c: CacheLite): Promise<boolean> => mayActAsOwner(req, env, c.owner_call);

async function adoptionState(req: Request, env: Env, c: CacheLite): Promise<Response> {
  const offer = c.source === "native" ? await loadOffer(env, c.id) : null;
  const me = await adopter(req, env);
  const owner = !!me && (await isOwner(req, env, c));
  const mine = me
    ? await env.DB.prepare(
        "SELECT * FROM cache_adoption_requests WHERE cache_id=? AND account_id=? ORDER BY id DESC LIMIT 1",
      )
        .bind(c.id, me.accountId)
        .first<RequestRow>()
    : null;
  const pending = mine?.status === "pending";
  const reason = !offer
    ? "this cache is not up for adoption"
    : !me
      ? "sign in to adopt a cache"
      : owner
        ? "you own this cache"
        : !me.verified
          ? "verify your callsign to adopt a cache"
          : pending
            ? "your request is waiting for the sysop"
            : null;
  return json({
    offer: offer
      ? { note: offer.note, offeredAt: offer.offered_at, noticeEndsAt: noticeEndsAt(c, offer.offered_at) }
      : null,
    isOwner: owner,
    request: mine
      ? {
          id: mine.id,
          status: mine.status,
          callsign: mine.callsign,
          inPlace: mine.in_place === 1,
          requestedAt: mine.requested_at,
          decidedAt: mine.decided_at,
        }
      : null,
    canRequest: reason === null,
    reason,
  });
}

async function requestAdoption(req: Request, env: Env, c: CacheLite): Promise<Response> {
  const me = await adopter(req, env);
  if (!me) return json({ error: "sign in to adopt a cache" }, { status: 401 });
  if (!me.verified)
    return json(
      { error: `verify ${baseCall(me.callsign)} to adopt a cache — control-verification required` },
      { status: 403 },
    );
  const offer = await loadOffer(env, c.id);
  if (!offer || c.source !== "native") return json({ error: "this cache is not up for adoption" }, { status: 409 });
  if (await isOwner(req, env, c)) return json({ error: "you already own this cache" }, { status: 409 });
  const b = (await req.json().catch(() => ({}))) as { inPlace?: unknown; note?: unknown };
  const n = noteOf(b.note, false);
  if ("error" in n) return json({ error: n.error }, { status: 400 });
  const inPlace = b.inPlace === true;
  try {
    const ins = await env.DB.prepare(
      `INSERT INTO cache_adoption_requests (cache_id, account_id, callsign, in_place, note, status, requested_at)
       VALUES (?,?,?,?,?, 'pending', ?)`,
    )
      .bind(c.id, me.accountId, me.callsign, inPlace ? 1 : 0, n.note, nowS())
      .run();
    await audit(env, c.id, "requested", me.callsign, { from: c.owner_call, to: me.callsign, note: n.note }).run();
    return json(
      { request: { id: Number(ins.meta.last_row_id), status: "pending", callsign: me.callsign, inPlace } },
      { status: 201 },
    );
  } catch (e) {
    if (/UNIQUE/i.test((e as Error).message ?? ""))
      return json({ error: "you already asked to adopt this cache" }, { status: 409 });
    throw e;
  }
}

async function cancelRequest(req: Request, env: Env, c: CacheLite): Promise<Response> {
  const me = await sessionIdentity(req, env);
  if (!me) return json({ error: "sign in first" }, { status: 401 });
  const r = await env.DB.prepare(
    "SELECT * FROM cache_adoption_requests WHERE cache_id=? AND account_id=? AND status='pending'",
  )
    .bind(c.id, me.accountId)
    .first<RequestRow>();
  if (!r) return json({ error: "no pending request" }, { status: 404 });
  await env.DB.batch([
    env.DB.prepare("UPDATE cache_adoption_requests SET status='cancelled', decided_at=?, decided_by=? WHERE id=?").bind(
      nowS(),
      r.callsign,
      r.id,
    ),
    audit(env, c.id, "request_cancelled", r.callsign, { from: c.owner_call, to: r.callsign }),
  ]);
  return json({ cancelled: true });
}

/** The active owner keeps the cache: the offer ends and its pending requests are cancelled. */
async function ownerDeclines(req: Request, env: Env, c: CacheLite): Promise<Response> {
  const me = await sessionIdentity(req, env);
  if (!me) return json({ error: "sign in first" }, { status: 401 });
  if (!(await isOwner(req, env, c)))
    return json({ error: "only the owner may decline an adoption offer" }, { status: 403 });
  if (!(await loadOffer(env, c.id))) return json({ error: "this cache is not up for adoption" }, { status: 404 });
  const who = me.callsign.toUpperCase();
  const s = await settlePending(env, c.id, "cancelled", who);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM cache_adoption_offers WHERE cache_id=?").bind(c.id),
    s.stmt,
    audit(env, c.id, "owner_declined", who, { from: c.owner_call }),
  ]);
  await tellDeclined(env, c, s.pending);
  return json({ kept: true });
}

// ---------------------------------------------------------------- sysop

/**
 * /api/admin/adoptions[...] — the sysop's side. `GET` lists withdrawn-owned caches not yet offered, the
 * standing offers with their pending requests, and the recent trail; `POST {cacheId|code, note}` offers a
 * cache; `DELETE /:cacheId` withdraws an offer; `POST /:cacheId/assign {callsign, note, activate?}` hands a
 * cache straight to a verified holder; `POST /requests/:id/{approve,decline} {note?}` decides a request.
 */
export async function handleAdminAdoptions(
  req: Request,
  env: Env,
  route: { cacheId?: number; assign?: boolean; requestId?: number; decision?: "approve" | "decline" } = {},
): Promise<Response> {
  const denied = await requireSysop(req, env);
  if (denied) return denied;
  const m = req.method;
  if (route.requestId !== undefined && route.decision && m === "POST")
    return decideRequest(req, env, route.requestId, route.decision);
  if (route.cacheId !== undefined && route.assign && m === "POST") return assign(req, env, route.cacheId);
  if (route.cacheId !== undefined && !route.assign && m === "DELETE") return withdrawOffer(req, env, route.cacheId);
  if (route.cacheId === undefined && route.requestId === undefined) {
    if (m === "GET") return adminList(env);
    if (m === "POST") return makeOffer(req, env);
  }
  return new Response("method not allowed", { status: 405 });
}

async function adminList(env: Env): Promise<Response> {
  const withdrawn = (
    await env.DB.prepare(
      `SELECT ${CACHE_COLS} FROM caches c
        WHERE c.source = 'native' AND c.removed_at IS NULL AND (c.owner_call = 'WITHDRAWN' OR c.owner_call LIKE 'WITHDRAWN#%')
          AND NOT EXISTS (SELECT 1 FROM cache_adoption_offers o WHERE o.cache_id = c.id)
        ORDER BY c.updated_at DESC, c.id DESC LIMIT 200`,
    ).all<CacheLite>()
  ).results;
  const offers = (
    await env.DB.prepare(
      `SELECT ${CACHE_COLS}, o.offered_by, o.note, o.offered_at FROM cache_adoption_offers o
         JOIN caches c ON c.id = o.cache_id WHERE c.removed_at IS NULL ORDER BY o.offered_at DESC LIMIT 200`,
    ).all<CacheLite & OfferRow>()
  ).results;
  const requests = (
    await env.DB.prepare(
      "SELECT * FROM cache_adoption_requests WHERE status='pending' ORDER BY requested_at, id LIMIT 1000",
    ).all<RequestRow>()
  ).results;
  const log = (
    await env.DB.prepare(
      `SELECT a.id, a.cache_id, c.code, a.action, a.actor_call, a.from_call, a.to_call, a.note, a.at
         FROM cache_adoptions a LEFT JOIN caches c ON c.id = a.cache_id ORDER BY a.id DESC LIMIT 100`,
    ).all<{
      id: number;
      cache_id: number;
      code: string | null;
      action: string;
      actor_call: string;
      from_call: string | null;
      to_call: string | null;
      note: string | null;
      at: number;
    }>()
  ).results;
  const shown = (s: string | null) => (s === null ? null : displayCall(s));
  return json({
    noticeSec: ADOPTION_NOTICE_SEC,
    withdrawn: withdrawn.map(cacheOut),
    offered: offers.map((o) => ({
      ...cacheOut(o),
      note: o.note,
      offeredBy: o.offered_by,
      offeredAt: o.offered_at,
      noticeEndsAt: noticeEndsAt(o, o.offered_at),
      requests: requests
        .filter((r) => r.cache_id === o.id)
        .map((r) => ({
          id: r.id,
          callsign: r.callsign,
          inPlace: r.in_place === 1,
          note: r.note,
          requestedAt: r.requested_at,
        })),
    })),
    log: log.map((l) => ({
      id: l.id,
      cacheId: l.cache_id,
      code: l.code,
      action: l.action,
      actor: shown(l.actor_call),
      from: shown(l.from_call),
      to: shown(l.to_call),
      note: l.note,
      at: l.at,
    })),
  });
}

async function makeOffer(req: Request, env: Env): Promise<Response> {
  const b = (await req.json().catch(() => ({}))) as { cacheId?: unknown; code?: unknown; note?: unknown };
  const c =
    typeof b.cacheId === "number"
      ? await loadCache(env, b.cacheId)
      : typeof b.code === "string" && b.code.trim()
        ? await env.DB.prepare(
            `SELECT ${CACHE_COLS} FROM caches c WHERE c.code = ? COLLATE NOCASE AND c.removed_at IS NULL`,
          )
            .bind(b.code.trim())
            .first<CacheLite>()
        : null;
  if (!c) return json({ error: "no such cache" }, { status: 404 });
  if (c.source !== "native")
    return json({ error: "only caches hidden on this instance can be offered for adoption" }, { status: 400 });
  const n = noteOf(b.note, true);
  if ("error" in n) return json({ error: `${n.error}, saying why the cache is up for adoption` }, { status: 400 });
  if (await loadOffer(env, c.id)) return json({ error: `${c.code} is already up for adoption` }, { status: 409 });
  const by = await sysopCall(req, env);
  await env.DB.batch([
    env.DB.prepare("INSERT INTO cache_adoption_offers (cache_id, offered_by, note, offered_at) VALUES (?,?,?,?)").bind(
      c.id,
      by,
      n.note,
      nowS(),
    ),
    audit(env, c.id, "offered", by, { from: c.owner_call, note: n.note }),
  ]);
  // an active owner hears about it and can keep the cache from its page
  await alertAccount(
    env,
    await ownerAccount(env, c),
    c,
    "adoption_offered",
    `${c.code} is offered for adoption: ${n.note} — open the cache to keep it`,
  );
  return json({ offered: true, cacheId: c.id, code: c.code }, { status: 201 });
}

async function withdrawOffer(req: Request, env: Env, cacheId: number): Promise<Response> {
  const c = await loadCache(env, cacheId);
  if (!c || !(await loadOffer(env, cacheId)))
    return json({ error: "this cache is not up for adoption" }, { status: 404 });
  const b = (await req.json().catch(() => ({}))) as { note?: unknown };
  const n = noteOf(b.note, false);
  if ("error" in n) return json({ error: n.error }, { status: 400 });
  const by = await sysopCall(req, env);
  const s = await settlePending(env, cacheId, "cancelled", by);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM cache_adoption_offers WHERE cache_id=?").bind(cacheId),
    s.stmt,
    audit(env, cacheId, "offer_withdrawn", by, { from: c.owner_call, note: n.note }),
  ]);
  await tellDeclined(env, c, s.pending);
  return json({ withdrawn: true });
}

/** A cache with an active owner changes hands only under an offer whose notice period has run out. */
async function noticeBlocks(env: Env, c: CacheLite): Promise<string | null> {
  if (isWithdrawnCall(c.owner_call)) return null;
  const o = await loadOffer(env, c.id);
  if (!o) return `${c.code} has an active owner: offer it for adoption first, so the owner is told`;
  const ends = noticeEndsAt(c, o.offered_at);
  if (nowS() < ends)
    return `${c.code} has an active owner, who can keep it until the notice period ends (${new Date(ends * 1000).toISOString().slice(0, 10)})`;
  return null;
}

async function assign(req: Request, env: Env, cacheId: number): Promise<Response> {
  const c = await loadCache(env, cacheId);
  if (!c) return json({ error: "no such cache" }, { status: 404 });
  if (c.source !== "native")
    return json({ error: "only caches hidden on this instance can change owner" }, { status: 400 });
  const b = (await req.json().catch(() => ({}))) as { callsign?: unknown; note?: unknown; activate?: unknown };
  const to = typeof b.callsign === "string" ? b.callsign.trim().toUpperCase() : "";
  if (!CALL_RE.test(to)) return json({ error: "a valid callsign is required" }, { status: 400 });
  const n = noteOf(b.note, true);
  if ("error" in n) return json({ error: `${n.error}, saying why the cache changes owner` }, { status: 400 });
  const holder = await baseHolder(env, baseCall(to));
  if (!holder) return json({ error: `no account holds ${baseCall(to)}` }, { status: 404 });
  if (!(await eligibleOwner(env, holder, to)))
    return json(
      { error: `${baseCall(to)} is not control-verified — verify it before handing a cache to it` },
      { status: 403 },
    );
  if (to === c.owner_call.toUpperCase()) return json({ error: `${to} already owns ${c.code}` }, { status: 409 });
  const blocked = await noticeBlocks(env, c);
  if (blocked) return json({ error: blocked }, { status: 409 });
  const by = await sysopCall(req, env);
  const s = await settlePending(env, c.id, "declined", by);
  const ok = await handOver(env, c, to, b.activate === true, [
    s.stmt,
    audit(env, c.id, "assigned", by, { from: c.owner_call, to, note: n.note }),
  ]);
  if (!ok) return json({ error: `${c.code} changed owner meanwhile — reload and try again` }, { status: 409 });
  await alertAccount(env, holder, c, "adoption_assigned", `You are now the owner of ${c.code}`);
  await tellDeclined(env, c, s.pending);
  return json({ assigned: true, cacheId: c.id, ownerCall: to });
}

async function decideRequest(
  req: Request,
  env: Env,
  requestId: number,
  decision: "approve" | "decline",
): Promise<Response> {
  const r = await env.DB.prepare("SELECT * FROM cache_adoption_requests WHERE id=?")
    .bind(requestId)
    .first<RequestRow>();
  if (!r) return json({ error: "no such request" }, { status: 404 });
  if (r.status !== "pending") return json({ error: `this request is already ${r.status}` }, { status: 409 });
  const c = await loadCache(env, r.cache_id);
  if (!c) return json({ error: "no such cache" }, { status: 404 });
  const b = (await req.json().catch(() => ({}))) as { note?: unknown };
  const n = noteOf(b.note, false);
  if ("error" in n) return json({ error: n.error }, { status: 400 });
  const by = await sysopCall(req, env);
  const now = nowS();

  if (decision === "decline") {
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE cache_adoption_requests SET status='declined', decided_at=?, decided_by=? WHERE id=?",
      ).bind(now, by, r.id),
      audit(env, c.id, "declined", by, { from: c.owner_call, to: r.callsign, note: n.note }),
    ]);
    await tellDeclined(env, c, [r]);
    return json({ declined: true });
  }

  if (!(await loadOffer(env, c.id))) return json({ error: "this cache is not up for adoption" }, { status: 409 });
  // the licence may have moved, or its verification been revoked, since the request was made
  if (!(await eligibleOwner(env, r.account_id, r.callsign)))
    return json({ error: `the requester no longer holds a control-verified ${baseCall(r.callsign)}` }, { status: 409 });
  const blocked = await noticeBlocks(env, c);
  if (blocked) return json({ error: blocked }, { status: 409 });
  const others = (
    await env.DB.prepare("SELECT * FROM cache_adoption_requests WHERE cache_id=? AND status='pending' AND id<>?")
      .bind(c.id, r.id)
      .all<RequestRow>()
  ).results;
  const ok = await handOver(env, c, r.callsign, r.in_place === 1, [
    env.DB.prepare("UPDATE cache_adoption_requests SET status='approved', decided_at=?, decided_by=? WHERE id=?").bind(
      now,
      by,
      r.id,
    ),
    env.DB.prepare(
      "UPDATE cache_adoption_requests SET status='declined', decided_at=?, decided_by=? WHERE cache_id=? AND status='pending'",
    ).bind(now, by, c.id),
    audit(env, c.id, "approved", by, { from: c.owner_call, to: r.callsign, note: n.note }),
  ]);
  if (!ok) return json({ error: `${c.code} changed owner meanwhile — reload and try again` }, { status: 409 });
  await alertAccount(env, r.account_id, c, "adoption_approved", `You are now the owner of ${c.code}`);
  await tellDeclined(env, c, others);
  return json({ approved: true, cacheId: c.id, ownerCall: r.callsign, status: r.in_place === 1 ? "active" : c.status });
}
