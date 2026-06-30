/**
 * forward.ts (gateway) — BBS forwarding + hierarchical routing (docs/25 P3). Loads the forward table
 * into the pure ForwardRouter (@aprsweb/packet), resolves a destination to a partner, keeps the FBB
 * White Pages (callsign → home BBS) for personal-mail steering, and exposes sysop CRUD for the rules.
 * The existing bulletin federation is the default 'ip-fed' catch-all partner; actually delivering to an
 * `rf-fbb` partner over an RF link is validate-at-deploy — this is the routing brain.
 */
import type { Env } from "./env.js";
import { json } from "./app.js";
import { parseHierAddr, ForwardRouter, type ForwardRule } from "@aprsweb/packet";

const now = () => Math.floor(Date.now() / 1000);

/** Build a router from the enabled forward rules. */
export async function loadRouter(env: Env): Promise<ForwardRouter> {
  const rows = (await env.DB.prepare("SELECT partner, route, transport FROM bbs_forward_rules WHERE enabled=1").all<ForwardRule>()).results;
  return new ForwardRouter(rows);
}

/** Look up a callsign's home BBS from the White Pages (null if unknown). */
async function homeBbs(env: Env, call: string): Promise<string | null> {
  const r = await env.DB.prepare("SELECT home_bbs FROM white_pages WHERE callsign=?").bind(call.toUpperCase()).first<{ home_bbs: string }>();
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
  ).bind(call.toUpperCase(), bbs.toUpperCase(), now()).run();
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

/** Sysop forward-rule CRUD: GET list · POST add · DELETE /:id. */
export async function handleForwardRules(req: Request, env: Env): Promise<Response> {
  if (req.method === "GET") {
    const rows = (await env.DB.prepare("SELECT id, partner, route, transport, enabled FROM bbs_forward_rules ORDER BY id").all()).results;
    return json({ rules: rows.map((r: any) => ({ ...r, enabled: !!r.enabled })) });
  }
  const b = (await req.json().catch(() => ({}))) as { partner?: string; route?: string; transport?: string };
  if (!b.partner || !b.route) return json({ error: "partner + route required" }, { status: 400 });
  const res = await env.DB.prepare(
    "INSERT INTO bbs_forward_rules (partner, route, transport, enabled, created_at) VALUES (?,?,?,1,?)",
  ).bind(b.partner.toLowerCase(), b.route.toUpperCase(), (b.transport ?? "rf-fbb").toLowerCase(), now()).run();
  return json({ ok: true, id: Number(res.meta.last_row_id) }, { status: 201 });
}

export async function handleForwardRuleDelete(req: Request, env: Env, id: number): Promise<Response> {
  await env.DB.prepare("DELETE FROM bbs_forward_rules WHERE id=?").bind(id).run();
  return json({ ok: true });
}
