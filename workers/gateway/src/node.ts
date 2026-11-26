// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * node.ts (gateway) — NET/ROM node read surface + sysop admin. Backs the pure NodeSession
 * CLI (@aprscaching/packet) and the shack node view with the NODES table + the per-port MHeard list.
 * recordMheard is called from ingest for every heard packet. Driving the node over actual AX.25
 * connects + advertising NODES on RF is validate-at-deploy; this is the table + admin.
 */
import { nowS } from "./util/time.js";
import type { Env } from "./env.js";
import { json } from "./http.js";
import { requireIngestOrOperator } from "./admin.js";
import { excludedCalls, isExcludedCall } from "./exclusions.js";

/**
 * Upsert the per-port MHeard entries for a batch (best-effort; called from ingest). A station heard
 * several times on one port in the batch is one upsert that adds all its hearings to the count.
 */
export async function recordMheard(env: Env, calls: { src: string; port: string }[]): Promise<void> {
  if (!calls.length) return;
  const ts = nowS();
  const heard = new Map<string, { callsign: string; port: string; n: number }>();
  for (const c of calls) {
    const callsign = c.src.toUpperCase();
    const key = `${callsign}\n${c.port}`;
    const h = heard.get(key);
    if (h) h.n++;
    else heard.set(key, { callsign, port: c.port, n: 1 });
  }
  await env.DB.batch(
    [...heard.values()].map((h) =>
      env.DB.prepare(
        `INSERT INTO node_mheard (callsign, port, last_heard, count) VALUES (?,?,?,?)
       ON CONFLICT(callsign, port) DO UPDATE SET last_heard=excluded.last_heard, count=count+excluded.count`,
      ).bind(h.callsign, h.port, ts, h.n),
    ),
  );
}

type NodeRoute = { dest?: unknown; alias?: unknown; neighbor?: unknown; quality?: unknown; port?: unknown };
type ValidRoute = { dest: string; alias: string; neighbor: string; quality: number; port: string | null };

/** The most routes one POST may carry: the ingest's whole NODES table. Both hosts run a batch as one SQLite
 *  transaction of single-row statements, so the size is bounded by this cap, not by the driver. */
const MAX_NODE_ROUTES = 500;

/** One route as stored, or why it is refused. NET/ROM allows a node without an alias, so a blank alias is kept. */
function validRoute(r: NodeRoute): ValidRoute | string {
  if (!r || typeof r !== "object") return "a route is an object";
  if (typeof r.dest !== "string" || !r.dest.trim() || typeof r.neighbor !== "string" || !r.neighbor.trim())
    return "dest + neighbor required";
  if (r.alias != null && typeof r.alias !== "string") return "alias must be text";
  const quality = r.quality ?? 100;
  if (typeof quality !== "number" || !Number.isInteger(quality) || quality < 0 || quality > 255)
    return "quality is 0-255";
  if (r.port != null && typeof r.port !== "string") return "port must be text";
  return {
    dest: r.dest.trim().toUpperCase(),
    alias: (r.alias ?? "").trim().toUpperCase(),
    neighbor: r.neighbor.trim().toUpperCase(),
    quality,
    port: r.port ?? null,
  };
}

/** GET /api/node/nodes (public read — operational NODES table) · POST (add node routes; operator or the
 *  operator-local ingest mirroring learned routes). A POST carries one route, or `{ nodes: [...] }` with up to
 *  500, which the ingest uses to mirror every route that changed in one request; a batch stores the valid
 *  routes and names each refused one, so one bad record never costs the others. */
export async function handleNodeNodes(req: Request, env: Env): Promise<Response> {
  if (req.method === "GET") {
    const rows = (
      await env.DB.prepare(
        "SELECT dest, alias, neighbor, quality, port FROM netrom_nodes ORDER BY quality DESC LIMIT 500",
      ).all()
    ).results;
    return json({ nodes: rows });
  }
  const gate = await requireIngestOrOperator(req, env);
  if (gate) return gate; // the ingest box mirroring learned routes, or the operator
  const b = (await req.json().catch(() => ({}))) as NodeRoute & { nodes?: unknown };
  const batch = Array.isArray(b?.nodes);
  const routes = (batch ? b.nodes : [b]) as NodeRoute[];
  if (routes.length > MAX_NODE_ROUTES)
    return json({ error: `at most ${MAX_NODE_ROUTES} routes per request` }, { status: 413 });
  const valid: ValidRoute[] = [];
  const refused: { index: number; dest: string | null; error: string }[] = [];
  routes.forEach((r, index) => {
    const v = validRoute(r);
    if (typeof v === "string")
      refused.push({ index, dest: typeof r?.dest === "string" ? r.dest.toUpperCase() : null, error: v });
    else valid.push(v);
  });
  if (!batch && refused.length) return json({ error: refused[0]!.error }, { status: 400 });
  // a route to a station excluded on its licensee's objection (exclusions.ts) is not kept
  const excluded = await excludedCalls(env);
  const kept = valid.filter((r) => !isExcludedCall(excluded, r.dest));
  const ts = nowS();
  if (kept.length)
    await env.DB.batch(
      kept.map((r) =>
        env.DB.prepare(
          `INSERT INTO netrom_nodes (dest, alias, neighbor, quality, port, heard_at) VALUES (?,?,?,?,?,?)
     ON CONFLICT(dest) DO UPDATE SET alias=excluded.alias, neighbor=excluded.neighbor, quality=excluded.quality, port=excluded.port, heard_at=excluded.heard_at`,
        ).bind(r.dest, r.alias, r.neighbor, r.quality, r.port, ts),
      ),
    );
  if (batch) return json({ ok: true, stored: kept.length, refused }, { status: 201 });
  if (!kept.length) return json({ ok: true, excluded: true });
  return json({ ok: true, dest: valid[0]!.dest }, { status: 201 });
}

/** GET /api/node/mheard — recently heard stations, newest first. */
export async function handleNodeMheard(req: Request, env: Env): Promise<Response> {
  const limit = Math.min(Math.max(Number(new URL(req.url).searchParams.get("limit")) || 50, 1), 200);
  const rows = (
    await env.DB.prepare(
      "SELECT callsign, port, last_heard AS lastHeard, count FROM node_mheard ORDER BY last_heard DESC LIMIT ?",
    )
      .bind(limit)
      .all()
  ).results;
  return json({ mheard: rows });
}
