// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * forward.ts (gateway) — BBS forwarding + hierarchical routing. Loads the forward table
 * into the pure ForwardRouter (@aprsweb/packet), resolves a destination to a partner, keeps the FBB
 * White Pages (callsign → home BBS) for personal-mail steering, and exposes sysop CRUD for the rules.
 * The existing bulletin federation is the default 'ip-fed' catch-all partner; actually delivering to an
 * `rf-fbb` partner over an RF link is validate-at-deploy — this is the routing brain.
 */
import type { Env } from "./env.js";
import { json } from "./app.js";
import { requireSysop } from "./admin.js";
import { parseHierAddr, ForwardRouter, type ForwardRule } from "@aprsweb/packet";

const now = () => Math.floor(Date.now() / 1000);

/** Build a router from the enabled forward rules. */
export async function loadRouter(env: Env): Promise<ForwardRouter> {
  const rows = (
    await env.DB.prepare("SELECT partner, route, transport FROM bbs_forward_rules WHERE enabled=1").all<ForwardRule>()
  ).results;
  return new ForwardRouter(rows);
}

/** Look up a callsign's home BBS from the White Pages (null if unknown). */
async function homeBbs(env: Env, call: string): Promise<string | null> {
  const r = await env.DB.prepare("SELECT home_bbs FROM white_pages WHERE callsign=?")
    .bind(call.toUpperCase())
    .first<{ home_bbs: string }>();
  return r?.home_bbs ?? null;
}

/** Resolve a destination (explicit "@bbs" address, or a callsign steered via White Pages) → partner. */
export async function resolvePartner(env: Env, dest: string): Promise<{ addr: string; partner: ForwardRule | null }> {
  let addr = dest.trim();
  if (!addr.includes("@")) {
    const home = await homeBbs(env, addr);
    if (home) addr = `${addr} @ ${home}`;
  }
  const router = await loadRouter(env);
  return { addr, partner: router.route(parseHierAddr(addr)) };
}

/** Learn a White Pages entry from a heard/posted message ("S OE8APR @ OE8XBM…"). Best-effort. */
export async function learnWhitePages(env: Env, call: string, bbs: string): Promise<void> {
  if (!call || !bbs) return;
  await env.DB.prepare(
    "INSERT INTO white_pages (callsign, home_bbs, updated_at) VALUES (?,?,?) ON CONFLICT(callsign) DO UPDATE SET home_bbs=excluded.home_bbs, updated_at=excluded.updated_at",
  )
    .bind(call.toUpperCase(), bbs.toUpperCase(), now())
    .run();
}

// ---- HTTP surface ----
/** GET /api/bbs/route?to=OE8APR  or  ?addr="OE8APR @ OE8XBM.OE.EU" — which partner handles it. */
export async function handleBbsRoute(req: Request, env: Env): Promise<Response> {
  const u = new URL(req.url);
  const dest = u.searchParams.get("addr") ?? u.searchParams.get("to");
  if (!dest) return json({ error: "to or addr required" }, { status: 400 });
  const { addr, partner } = await resolvePartner(env, dest);
  return json({ addr, parsed: parseHierAddr(addr), partner });
}

/** White Pages: GET ?call= (lookup) · POST {callsign, homeBbs} (set). */
export async function handleWhitePages(req: Request, env: Env): Promise<Response> {
  if (req.method === "GET") {
    const call = new URL(req.url).searchParams.get("call");
    if (!call) return json({ error: "call required" }, { status: 400 });
    return json({ callsign: call.toUpperCase(), homeBbs: await homeBbs(env, call) });
  }
  const b = (await req.json().catch(() => ({}))) as { callsign?: string; homeBbs?: string };
  if (!b.callsign || !b.homeBbs) return json({ error: "callsign + homeBbs required" }, { status: 400 });
  await learnWhitePages(env, b.callsign, b.homeBbs);
  return json({ ok: true, callsign: b.callsign.toUpperCase(), homeBbs: b.homeBbs.toUpperCase() });
}

/** Operator forward-rule CRUD: GET list · POST add · DELETE /:id. Sysop session or the operator secret. */
export async function handleForwardRules(req: Request, env: Env): Promise<Response> {
  const gate = await requireSysop(req, env, { allowIngest: true });
  if (gate) return gate;
  if (req.method === "GET") {
    const rows = (
      await env.DB.prepare("SELECT id, partner, route, transport, enabled FROM bbs_forward_rules ORDER BY id").all()
    ).results;
    return json({ rules: rows.map((r: any) => ({ ...r, enabled: !!r.enabled })) });
  }
  const b = (await req.json().catch(() => ({}))) as { partner?: string; route?: string; transport?: string };
  if (!b.partner || !b.route) return json({ error: "partner + route required" }, { status: 400 });
  const res = await env.DB.prepare(
    "INSERT INTO bbs_forward_rules (partner, route, transport, enabled, created_at) VALUES (?,?,?,1,?)",
  )
    .bind(b.partner.toLowerCase(), b.route.toUpperCase(), (b.transport ?? "rf-fbb").toLowerCase(), now())
    .run();
  return json({ ok: true, id: Number(res.meta.last_row_id) }, { status: 201 });
}

export async function handleForwardRuleDelete(req: Request, env: Env, id: number): Promise<Response> {
  const gate = await requireSysop(req, env, { allowIngest: true });
  if (gate) return gate;
  await env.DB.prepare("DELETE FROM bbs_forward_rules WHERE id=?").bind(id).run();
  return json({ ok: true });
}

// ---- FBB forwarding partners ----
const PARTNER_PROTOS = ["rf-fbb", "axudp", "ip-fed"] as const;
export interface ForwardPartner {
  call: string;
  ha: string | null;
  connectScript: string;
  proto: (typeof PARTNER_PROTOS)[number];
  intervalMin: number;
  timebands: string;
  requestReverse: boolean;
  msgtypes: string;
  maxBlock: number;
  enabled: boolean;
}
const clampInt = (v: unknown, lo: number, hi: number, dflt: number): number => {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
};

/**
 * Normalize + validate a partner from untrusted JSON into a safe row (pure → unit-tested). Uppercases the
 * call/HA, keeps msgtypes to the P/B/T set, caps the block size to the FBB spec limit (5), and only accepts
 * a known transport. Returns null when the mandatory callsign is missing/blank.
 */
export function normalizePartner(input: unknown): ForwardPartner | null {
  const b = (input ?? {}) as Record<string, unknown>;
  const call = String(b.call ?? "")
    .trim()
    .toUpperCase();
  if (!/^[A-Z0-9]{3,6}(-\d{1,2})?$/.test(call)) return null;
  const proto = PARTNER_PROTOS.includes(b.proto as never) ? (b.proto as ForwardPartner["proto"]) : "rf-fbb";
  const msgtypes =
    [
      ...new Set(
        String(b.msgtypes ?? "PBT")
          .toUpperCase()
          .split("")
          .filter((c) => "PBT".includes(c)),
      ),
    ].join("") || "PBT";
  const timebands = String(b.timebands ?? "")
    .replace(/[^0-9,\-]/g, "")
    .slice(0, 64);
  return {
    call,
    ha: b.ha != null && String(b.ha).trim() ? String(b.ha).trim().toUpperCase().slice(0, 64) : null,
    connectScript: String(b.connectScript ?? "").slice(0, 512),
    proto,
    intervalMin: clampInt(b.intervalMin, 0, 1440, 30),
    timebands,
    requestReverse: b.requestReverse == null ? true : !!b.requestReverse,
    msgtypes,
    maxBlock: clampInt(b.maxBlock, 1, 5, 5),
    enabled: b.enabled == null ? true : !!b.enabled,
  };
}

const partnerRow = (r: any): ForwardPartner & { id: number } => ({
  id: r.id,
  call: r.call,
  ha: r.ha,
  connectScript: r.connect_script,
  proto: r.proto,
  intervalMin: r.interval_min,
  timebands: r.timebands,
  requestReverse: !!r.request_reverse,
  msgtypes: r.msgtypes,
  maxBlock: r.max_block,
  enabled: !!r.enabled,
});

/** Operator partner CRUD: GET list · POST create (upsert by call). Sysop session or the operator secret
 *  (the forwarder ingest loads the list with its INGEST_SECRET). Never a plain user. */
export async function handleForwardPartners(req: Request, env: Env): Promise<Response> {
  const gate = await requireSysop(req, env, { allowIngest: true });
  if (gate) return gate;
  if (req.method === "GET") {
    const rows = (
      await env.DB.prepare(
        "SELECT id, call, ha, connect_script, proto, interval_min, timebands, request_reverse, msgtypes, max_block, enabled FROM bbs_partners ORDER BY call",
      ).all()
    ).results;
    return json({ partners: rows.map(partnerRow) });
  }
  const p = normalizePartner(await req.json().catch(() => ({})));
  if (!p) return json({ error: "valid partner call required" }, { status: 400 });
  const ts = now();
  await env.DB.prepare(
    `INSERT INTO bbs_partners (call, ha, connect_script, proto, interval_min, timebands, request_reverse, msgtypes, max_block, enabled, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(call) DO UPDATE SET ha=excluded.ha, connect_script=excluded.connect_script, proto=excluded.proto,
       interval_min=excluded.interval_min, timebands=excluded.timebands, request_reverse=excluded.request_reverse,
       msgtypes=excluded.msgtypes, max_block=excluded.max_block, enabled=excluded.enabled, updated_at=excluded.updated_at`,
  )
    .bind(
      p.call,
      p.ha,
      p.connectScript,
      p.proto,
      p.intervalMin,
      p.timebands,
      p.requestReverse ? 1 : 0,
      p.msgtypes,
      p.maxBlock,
      p.enabled ? 1 : 0,
      ts,
      ts,
    )
    .run();
  const row = await env.DB.prepare(
    "SELECT id, call, ha, connect_script, proto, interval_min, timebands, request_reverse, msgtypes, max_block, enabled FROM bbs_partners WHERE call=?",
  )
    .bind(p.call)
    .first();
  return json({ ok: true, partner: partnerRow(row) }, { status: 201 });
}

export async function handleForwardPartnerDelete(req: Request, env: Env, id: number): Promise<Response> {
  const gate = await requireSysop(req, env, { allowIngest: true });
  if (gate) return gate;
  await env.DB.prepare("DELETE FROM bbs_partners WHERE id=?").bind(id).run();
  return json({ ok: true });
}

// ---- FBB forwarding pool — the ingest scheduler pulls outbound / pushes inbound here ----
/** An FBB message on the wire (matches @aprsweb/packet FbbMessage; the ingest feeds these to FbbSession). */
export interface FbbWireMsg {
  type: "P" | "B";
  from: string;
  at: string;
  to: string;
  bid: string;
  title: string;
  body: string;
}
interface PoolRow {
  id: number;
  bid: string | null;
  type: string;
  from_call: string;
  to_call: string;
  subject: string | null;
  body: string;
}

/** Map a local bbs_messages row → the FBB wire shape. `at` is the routing hint (partner HA). Pure. */
export function fbbFromRow(r: PoolRow, instance: string, at: string): FbbWireMsg {
  return {
    type: r.type === "B" ? "B" : "P", // FBB proposes P or B; T (traffic) rides as P
    from: r.from_call,
    at,
    to: r.to_call,
    bid: r.bid ?? `${r.id}_${instance}`,
    title: r.subject ?? "",
    body: r.body,
  };
}

/** Values for INSERT OR IGNORE of an inbound forwarded message (BID-deduped). Pure; null if invalid. */
export function inboundRow(
  m: Partial<FbbWireMsg>,
  origin: string,
  ts: number,
): {
  bid: string;
  type: string;
  from: string;
  to: string;
  title: string;
  body: string;
  posted: number;
  origin: string;
} | null {
  if (!m.bid || !m.from || !m.to || m.body == null) return null;
  return {
    bid: m.bid,
    type: m.type === "B" ? "B" : "P",
    from: String(m.from).toUpperCase(),
    to: String(m.to).toUpperCase(),
    title: m.title ?? "",
    body: String(m.body),
    posted: ts,
    origin,
  };
}

const ingestOk = (req: Request, env: Env) => req.headers.get("x-ingest-secret") === env.INGEST_SECRET;

/** GET /api/bbs/forward/pool?partner=CALL&limit= — local messages routed to that partner, not yet forwarded. */
export async function handleForwardPool(req: Request, env: Env): Promise<Response> {
  if (!ingestOk(req, env)) return new Response("unauthorized", { status: 401 });
  const u = new URL(req.url);
  const partner = (u.searchParams.get("partner") ?? "").toUpperCase();
  if (!partner) return json({ error: "partner required" }, { status: 400 });
  const limit = Math.min(Math.max(Number(u.searchParams.get("limit")) || 20, 1), 50);
  const instance = env.INSTANCE ?? u.host;
  const at =
    (await env.DB.prepare("SELECT ha FROM bbs_partners WHERE call=?").bind(partner).first<{ ha: string | null }>())
      ?.ha ?? partner;

  const rows = (
    await env.DB.prepare(
      `SELECT m.id, m.bid, m.type, m.from_call, m.to_call, m.subject, m.body, m.posted_at
       FROM bbs_messages m
       WHERE m.origin='local' AND m.bid IS NOT NULL AND (m.expires_at IS NULL OR m.expires_at > ?)
         AND NOT EXISTS (SELECT 1 FROM bbs_forward_log l WHERE l.partner=? AND l.bid=m.bid)
       ORDER BY m.posted_at LIMIT 200`,
    )
      .bind(now(), partner)
      .all<PoolRow>()
  ).results;

  const out: FbbWireMsg[] = [];
  for (const r of rows) {
    // route the destination (White Pages expands a bare call to "CALL @ homeBBS", then the @AT hierarchy matches a rule)
    const { partner: rule } = await resolvePartner(env, r.to_call);
    if ((rule?.partner ?? "").toUpperCase() !== partner) continue;
    out.push(fbbFromRow(r, instance, at));
    if (out.length >= limit) break;
  }
  return json({ partner, messages: out });
}

/** POST /api/bbs/forward/inbound {message} — store an inbound forwarded message (BID-deduped). */
export async function handleForwardInbound(req: Request, env: Env): Promise<Response> {
  if (!ingestOk(req, env)) return new Response("unauthorized", { status: 401 });
  const b = (await req.json().catch(() => ({}))) as { message?: Partial<FbbWireMsg>; origin?: string };
  const row = inboundRow(b.message ?? {}, (b.origin ?? "rf-fbb").slice(0, 32), now());
  if (!row) return json({ error: "bid, from, to, body required" }, { status: 400 });
  const res = await env.DB.prepare(
    `INSERT OR IGNORE INTO bbs_messages (bid, type, from_call, to_call, subject, body, posted_at, origin)
     VALUES (?,?,?,?,?,?,?,?)`,
  )
    .bind(row.bid, row.type, row.from, row.to, row.title || null, row.body, row.posted, row.origin)
    .run();
  if (row.type === "P") await learnWhitePages(env, row.from, row.origin); // FBB White Pages: learn HomeBBS from P-mail
  return json({ ok: true, stored: res.meta.changes ? 1 : 0, deduped: !res.meta.changes });
}

/** POST /api/bbs/forward/sent {partner, bids} — mark messages forwarded to a partner (don't re-offer). */
export async function handleForwardSent(req: Request, env: Env): Promise<Response> {
  if (!ingestOk(req, env)) return new Response("unauthorized", { status: 401 });
  const b = (await req.json().catch(() => ({}))) as { partner?: string; bids?: string[] };
  const partner = (b.partner ?? "").toUpperCase();
  if (!partner || !Array.isArray(b.bids) || !b.bids.length)
    return json({ error: "partner + bids required" }, { status: 400 });
  const ts = now();
  await env.DB.batch(
    b.bids
      .slice(0, 200)
      .map((bid) =>
        env.DB.prepare("INSERT OR IGNORE INTO bbs_forward_log (partner, bid, forwarded_at) VALUES (?,?,?)").bind(
          partner,
          String(bid),
          ts,
        ),
      ),
  );
  return json({ ok: true, marked: Math.min(b.bids.length, 200) });
}
