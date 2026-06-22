import type { Env } from "./env.js";
import type { ExecCtx, SqlStatement } from "./runtime.js";
import { json } from "./app.js";
import { IngestBatch } from "@aprsweb/shared";

/** Receive batched packets from the ingest box, persist positions, dispatch geofences. */
export async function handleIngest(req: Request, env: Env, _ctx: ExecCtx): Promise<Response> {
  if (req.headers.get("x-ingest-secret") !== env.INGEST_SECRET)
    return new Response("unauthorized", { status: 401 });

  const body = IngestBatch.safeParse(await req.json());
  if (!body.success) return json({ error: "bad batch" }, { status: 400 });

  const stmts: SqlStatement[] = [];
  for (const p of body.data.packets) {
    const pos = (p.parsed as any)?.lat != null ? (p.parsed as any) : null;
    if (!pos) continue;
    stmts.push(
      env.DB.prepare(
        `INSERT INTO positions (callsign, ts, lat, lon, heard_via, igate_call, path, source)
         VALUES (?,?,?,?,?,?,?, 'firehose')`,
      ).bind(p.src, p.ts, pos.lat, pos.lon, p.heardVia, p.igateCall ?? null, p.path.join(",")),
    );
    stmts.push(
      env.DB.prepare(
        `INSERT INTO stations (callsign, lat, lon, last_seen, symbol)
         VALUES (?,?,?,?,?)
         ON CONFLICT(callsign) DO UPDATE SET lat=excluded.lat, lon=excluded.lon, last_seen=excluded.last_seen`,
      ).bind(p.src, pos.lat, pos.lon, p.ts, pos.symbol ?? null),
    );
    // TODO M2: forward to the region RegionRoom for live fan-out + geofence check
  }
  if (stmts.length) await env.DB.batch(stmts);
  return json({ ok: true, stored: stmts.length / 2 });
}
