// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * views.ts — save / share map views. A signed-in user saves the current map state and
 * gets a short permalink; anyone can resolve a public view to restore it. The app applies the state.
 *
 *   POST   /api/views          save { name?, state, public? } → { slug }
 *   GET    /api/views          my saved views (session)
 *   DELETE /api/views/:slug    delete (owner)
 *   GET    /v/:slug            resolve a public view → { name, state, ownerCall, createdAt }
 */
import { nowS } from "./util/time.js";
import { randomString } from "./util/random.js";
import type { Env } from "./env.js";
import { json } from "./http.js";
import { sessionIdentity, mayActAsOwner } from "./auth.js";

const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";
const makeSlug = (): string => randomString(ALPHABET, 8);

export async function handleViewCreate(req: Request, env: Env): Promise<Response> {
  const owner = (await sessionIdentity(req, env))?.callsign;
  if (!owner) return json({ error: "sign in to save a view" }, { status: 401 });
  const body = (await req.json().catch(() => ({}))) as { name?: string; state?: unknown; public?: boolean };
  if (!body.state || typeof body.state !== "object") return json({ error: "state object required" }, { status: 400 });
  const stateStr = JSON.stringify(body.state);
  if (stateStr.length > 4096) return json({ error: "state too large" }, { status: 400 });
  // tiny retry on the astronomically-unlikely slug collision
  for (let attempt = 0; attempt < 3; attempt++) {
    const slug = makeSlug();
    try {
      await env.DB.prepare(
        "INSERT INTO saved_views (slug, owner_call, name, state, public, created_at) VALUES (?,?,?,?,?,?)",
      )
        .bind(
          slug,
          owner.toUpperCase(),
          (body.name ?? "").slice(0, 80) || null,
          stateStr,
          body.public === false ? 0 : 1,
          nowS(),
        )
        .run();
      return json({ slug, public: body.public !== false }, { status: 201 });
    } catch (e) {
      if (!/UNIQUE/i.test((e as Error).message)) throw e;
    }
  }
  return json({ error: "could not allocate a slug" }, { status: 500 });
}

/** GET /api/views — the views saved under any call the signed-in account holds (or an SSID of one). */
export async function handleViewList(req: Request, env: Env): Promise<Response> {
  const me = await sessionIdentity(req, env);
  if (!me) return json({ error: "sign in" }, { status: 401 });
  const held = (
    await env.DB.prepare("SELECT callsign FROM account_callsigns WHERE account_id = ?")
      .bind(me.accountId)
      .all<{ callsign: string }>()
  ).results.map((r) => r.callsign);
  const rows = (
    await env.DB.prepare(
      `SELECT slug, name, public, created_at AS createdAt FROM saved_views
        WHERE ${held.map(() => "owner_call = ? OR owner_call LIKE ?").join(" OR ")}
        ORDER BY created_at DESC LIMIT 100`,
    )
      .bind(...held.flatMap((c) => [c, `${c}-%`]))
      .all<{ public: number }>()
  ).results.map((r) => ({ ...r, public: r.public === 1 }));
  return json({ views: rows });
}

export async function handleViewDelete(req: Request, env: Env, slug: string): Promise<Response> {
  if (!(await sessionIdentity(req, env))) return json({ error: "sign in" }, { status: 401 });
  const row = await env.DB.prepare("SELECT owner_call FROM saved_views WHERE slug = ?")
    .bind(slug)
    .first<{ owner_call: string }>();
  if (!row) return json({ error: "not found" }, { status: 404 });
  if (!(await mayActAsOwner(req, env, row.owner_call))) return json({ error: "not your view" }, { status: 403 });
  await env.DB.prepare("DELETE FROM saved_views WHERE slug = ?").bind(slug).run();
  return json({ ok: true });
}

/** GET /v/:slug — resolve a public view (or the owner's own private one). */
export async function handleViewResolve(req: Request, env: Env, slug: string): Promise<Response> {
  const row = await env.DB.prepare(
    "SELECT owner_call AS ownerCall, name, state, public, created_at AS createdAt FROM saved_views WHERE slug = ?",
  )
    .bind(slug)
    .first<{ ownerCall: string; name: string | null; state: string; public: number; createdAt: number }>();
  if (!row) return json({ error: "view not found" }, { status: 404 });
  if (row.public !== 1 && !(await mayActAsOwner(req, env, row.ownerCall)))
    return json({ error: "this view is private" }, { status: 403 });
  return json({
    slug,
    name: row.name,
    ownerCall: row.ownerCall,
    createdAt: row.createdAt,
    state: JSON.parse(row.state),
  });
}
