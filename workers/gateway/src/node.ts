// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * node.ts (gateway) — NET/ROM node read surface + sysop admin. Backs the pure NodeSession
 * CLI (@aprscaching/packet) and the shack node view with the NODES table + the per-port MHeard list.
 * recordMheard is called from ingest for every heard packet. Driving the node over actual AX.25
 * connects + advertising NODES on RF is validate-at-deploy; this is the table + admin.
 */
import { nowS } from "./util/time.js";
import type { Env } from "./env.js";
import { json } from "./app.js";
import { requireIngestOrOperator } from "./admin.js";

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

/** GET /api/node/nodes (public read — operational NODES table) · POST (add a node route; operator or the
 *  operator-local ingest mirroring learned routes). */
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
  const b = (await req.json().catch(() => ({}))) as {
    dest?: string;
    alias?: string;
    neighbor?: string;
    quality?: number;
    port?: string;
  };
  if (!b.dest || !b.alias || !b.neighbor) return json({ error: "dest + alias + neighbor required" }, { status: 400 });
  await env.DB.prepare(
    `INSERT INTO netrom_nodes (dest, alias, neighbor, quality, port, heard_at) VALUES (?,?,?,?,?,?)
     ON CONFLICT(dest) DO UPDATE SET alias=excluded.alias, neighbor=excluded.neighbor, quality=excluded.quality, port=excluded.port, heard_at=excluded.heard_at`,
  )
    .bind(
      b.dest.toUpperCase(),
      b.alias.toUpperCase(),
      b.neighbor.toUpperCase(),
      b.quality ?? 100,
      b.port ?? null,
      nowS(),
    )
    .run();
  return json({ ok: true, dest: b.dest.toUpperCase() }, { status: 201 });
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
