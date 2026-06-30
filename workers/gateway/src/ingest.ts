import type { Env } from "./env.js";
import type { ExecCtx, SqlStatement } from "./runtime.js";
import { json } from "./app.js";
import { IngestBatch } from "@aprsweb/shared";
import { decodeAprs } from "@aprsweb/aprs";
import { envelopeForPosition, dispatchLive, type LiveEnvelope } from "./live.js";
import { deliverHeld, bbsOnAck } from "./bbs.js";
import { recordWatchHeard } from "./watch.js";
import { recordRendezvous } from "./rendezvous.js";
import { verifySignedIngest } from "./keys.js";
import { rateLimited } from "./corroborate_privacy.js";

/** Position-bearing decoded data (position/object/item/weather with a fix). */
function fixOf(p: { parsed?: unknown; dst?: string; path: string[]; payload: string; src: string }):
  { lat: number; lon: number; symbol?: string; course?: number; speedKn?: number; altitudeM?: number; comment?: string } | null {
  const d = decodeAprs({ src: p.src, dst: p.dst ?? "", path: p.path, payload: p.payload, raw: "" }) as any;
  if ((d.kind === "position" || d.kind === "object" || d.kind === "item" || d.kind === "weather") && typeof d.lat === "number" && d.lat !== 0) {
    const sym = d.symbol ? `${d.symbol.table}${d.symbol.code}` : undefined;
    return { lat: d.lat, lon: d.lon, symbol: sym, course: d.course, speedKn: d.speedKn, altitudeM: d.altitudeM, comment: d.comment };
  }
  // fall back to a pre-parsed {lat,lon,symbol} supplied by the ingest box
  const pp = p.parsed as any;
  if (pp?.lat != null) return { lat: pp.lat, lon: pp.lon, symbol: pp.symbol };
  return null;
}

/** Receive batched packets from the ingest box, persist positions, enrich the workbench, fan out live. */
export async function handleIngest(req: Request, env: Env, _ctx: ExecCtx): Promise<Response> {
  const body = IngestBatch.safeParse(await req.json());
  if (!body.success) return json({ error: "bad batch" }, { status: 400 });

  // Auth: the shared secret (trusted backend / self-host ingest) OR a signed browser batch (H1.5):
  // an operator's device key, registered to their callsign, signs the batch — so a PUBLIC gateway
  // accepts browser RF without handing out the shared secret. Signed batches are NOT trusted to
  // attribute an independent IGate, so their fixes are stored IGate-less and stay Tier C.
  const trusted = req.headers.get("x-ingest-secret") === env.INGEST_SECRET;
  if (!trusted) {
    const signed = await verifySignedIngest(req, env, body.data.packets);
    if (!signed) return new Response("unauthorized", { status: 401 });
    if (rateLimited(`ingest:${signed.callsign}`, Date.now(), 240, 60_000))
      return json({ error: "rate limited" }, { status: 429 });
  }

  const stmts: SqlStatement[] = [];
  const positions: { src: string; lat: number; lon: number; symbol?: string; course?: number }[] = [];
  const portRx = new Map<string, number>(); // RX packets per transport port, this batch
  const ackedBy: { from: string; lineNo: string }[] = []; // BBS delivery acks seen this batch
  let maxTs = 0;
  for (const p of body.data.packets) {
    portRx.set(p.port, (portRx.get(p.port) ?? 0) + 1);
    if (p.ts > maxTs) maxTs = p.ts;
    const data = decodeAprs({ src: p.src, dst: p.dst ?? "", path: p.path, payload: p.payload, raw: "" }) as any;

    // weather -> sensor_readings (latest reading per station+ts)
    if (data.kind === "weather") {
      stmts.push(
        env.DB.prepare(
          `INSERT OR REPLACE INTO sensor_readings (station, ts, temp_c, humidity, pressure_hpa, wind_dir, wind_kn, rain_mm)
           VALUES (?,?,?,?,?,?,?,?)`,
        ).bind(p.src, p.ts, data.tempC ?? null, data.humidity ?? null, data.pressureHpa ?? null,
          data.windDirDeg ?? null, data.windKn ?? null, data.rain1hMm ?? null),
      );
    }
    // text message -> messages log; ack -> BBS delivery confirmation
    if (data.kind === "message" && !data.ack && !data.rej) {
      stmts.push(
        env.DB.prepare(
          "INSERT INTO messages (ts, from_call, to_call, body, ack, direction) VALUES (?,?,?,?,?, 'rx')",
        ).bind(p.ts, p.src, data.addressee ?? null, data.text ?? "", data.msgNo ?? null),
      );
    } else if (data.kind === "message" && data.ack && data.msgNo) {
      ackedBy.push({ from: p.src, lineNo: data.msgNo });
    }

    // workbench raw packet view (docs/26 Stage 0.2): a short, TTL-pruned ring of raw frames per
    // station — every heard packet, not only position fixes (status, telemetry, messages too).
    stmts.push(
      env.DB.prepare(
        "INSERT INTO packets_recent (callsign, ts, dst, path, payload, heard_via, port) VALUES (?,?,?,?,?,?,?)",
      ).bind(p.src, p.ts, p.dst ?? null, p.path.join(","), p.payload, p.heardVia, p.port),
    );

    const fix = fixOf(p);
    if (!fix) continue;
    positions.push({ src: p.src, lat: fix.lat, lon: fix.lon, symbol: fix.symbol, course: fix.course });
    // A signed browser batch may NOT assert an independent IGate (no self-corroboration to Tier A),
    // so its fixes are stored IGate-less + tagged 'browser-rf'; trusted backends keep their IGate.
    const igate = trusted ? (p.igateCall ?? null) : null;
    const src = trusted ? "firehose" : "browser-rf";
    stmts.push(
      env.DB.prepare(
        `INSERT INTO positions (callsign, ts, lat, lon, heard_via, igate_call, path, source, speed_kn, altitude_m, course)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      ).bind(p.src, p.ts, fix.lat, fix.lon, p.heardVia, igate, p.path.join(","), src,
        fix.speedKn ?? null, fix.altitudeM ?? null, fix.course ?? null),
    );
    stmts.push(
      env.DB.prepare(
        `INSERT INTO stations (callsign, lat, lon, last_seen, symbol, course, speed_kn, altitude_m, comment, source_call)
         VALUES (?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(callsign) DO UPDATE SET lat=excluded.lat, lon=excluded.lon, last_seen=excluded.last_seen,
           symbol=excluded.symbol, course=excluded.course, speed_kn=excluded.speed_kn,
           altitude_m=excluded.altitude_m, comment=COALESCE(excluded.comment, stations.comment)`,
      ).bind(p.src, fix.lat, fix.lon, p.ts, fix.symbol ?? null, fix.course ?? null,
        fix.speedKn ?? null, fix.altitudeM ?? null, fix.comment ?? null, igate),
    );
    // Keep a registered operated-station's location live: if this callsign is in someone's registry,
    // an APRS position fix updates its stored coordinates (docs/13 — "updated via APRS if heard").
    stmts.push(
      env.DB.prepare("UPDATE account_stations SET lat = ?, lon = ?, updated_at = ? WHERE callsign = ?")
        .bind(fix.lat, fix.lon, p.ts, p.src),
    );
  }
  // M6: per-transport RX counters, bucketed by hour (port_stats)
  const bucket = Math.floor((maxTs || Math.floor(Date.now() / 1000)) / 3600) * 3600;
  for (const [port, rx] of portRx) {
    stmts.push(
      env.DB.prepare(
        `INSERT INTO port_stats (port, ts, rx, tx) VALUES (?,?,?,0)
         ON CONFLICT(port, ts) DO UPDATE SET rx = rx + excluded.rx`,
      ).bind(port, bucket, rx),
    );
  }
  if (stmts.length) await env.DB.batch(stmts);

  // BBS: confirm deliveries that were acked, and (re)deliver held mail to stations just heard
  for (const a of ackedBy) await bbsOnAck(env, a.from, a.lineNo);
  const heardCalls = new Set(positions.map((p) => p.src.toUpperCase()));
  for (const cs of heardCalls) await deliverHeld(env, cs);

  // W1: raise watchlist alerts for any watched callsign just heard (best-effort; never blocks ingest)
  try { await recordWatchHeard(env, positions.map((p) => ({ src: p.src, lat: p.lat, lon: p.lon }))); }
  catch (e) { console.error("watch alerts:", (e as Error).message); }

  // F-4: record living-cache rendezvous for any opted-in living cache just heard (best-effort)
  try { await recordRendezvous(env, positions.map((p) => ({ src: p.src, lat: p.lat, lon: p.lon }))); }
  catch (e) { console.error("rendezvous:", (e as Error).message); }

  // M2: live fan-out — station deltas + "you're near a cache" geofence prompts
  const envelopes: LiveEnvelope[] = [];
  for (const p of positions) envelopes.push(await envelopeForPosition(env, p.src, p.lat, p.lon, p.symbol, p.course));
  await dispatchLive(env, envelopes);

  return json({ ok: true, stored: positions.length });
}
