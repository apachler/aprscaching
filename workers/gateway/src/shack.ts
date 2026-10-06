// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * shack.ts — M5 platform depth: a live APRS station registry + a packet inspector.
 * Stations and weather are enriched at ingest time (see ingest.ts) using the @aprscaching/aprs
 * decoder; these read endpoints expose them, plus an on-demand decode tool for raw TNC2 lines.
 */
import { nowS } from "./util/time.js";
import type { Env } from "./env.js";
import { json } from "./http.js";
import { parseTNC2, classifyQ, decodeAprs } from "@aprscaching/aprs";
import { parsePage, keyset, paginate } from "./paging.js";
import { lastSeenLagS } from "./downsample.js";
import { sessionIdentity, displayCall } from "./auth.js";
import { isCallsignVerified } from "./callsign.js";
import { baseCall } from "@aprscaching/aprs";
import { serviceCall } from "./servicecall.js";
import { OUTBOX_QUEUED_TTL_S } from "./retention.js";

// ------------------------------------------------------------- packet inspector
export async function handleDecode(req: Request): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as { raw?: string };
  const raw = (body.raw ?? "").trim();
  if (!raw) return json({ ok: false, error: "raw TNC2 line required" }, { status: 400 });
  const frame = parseTNC2(raw);
  if (!frame) return json({ ok: false, error: "not a TNC2 frame" }, { status: 400 });
  const q = classifyQ(frame.path);
  const data = decodeAprs(frame);
  return json({
    ok: true,
    frame: {
      src: frame.src,
      dst: frame.dst,
      path: frame.path,
      payload: frame.payload,
      heardVia: q.heardVia,
      igateCall: q.igateCall,
    },
    data,
  });
}

// ------------------------------------------------------------- station registry
function bbox(u: URL): { sql: string; binds: number[] } {
  const b = u.searchParams.get("bbox");
  if (!b) return { sql: "", binds: [] };
  const p = b.split(",").map(Number);
  if (p.length < 4 || p.some(Number.isNaN)) return { sql: "", binds: [] };
  const [minLon, minLat, maxLon, maxLat] = p as [number, number, number, number];
  return { sql: " AND s.lat BETWEEN ? AND ? AND s.lon BETWEEN ? AND ?", binds: [minLat, maxLat, minLon, maxLon] };
}

/** Split a stored roles csv into the typed array, dropping blanks/unknowns. */
function rolesArr(csv: string | null): string[] | undefined {
  if (!csv) return undefined;
  const arr = csv
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return arr.length ? arr : undefined;
}

export async function handleStations(req: Request, env: Env): Promise<Response> {
  const u = new URL(req.url);
  const maxAge = Math.min(Math.max(Number(u.searchParams.get("maxAge") ?? 3600) || 3600, 60), 7 * 86400);
  const limit = Math.min(Math.max(Number(u.searchParams.get("limit") ?? 500) || 500, 1), 2000);
  const bb = bbox(u);
  // a stationary station's last_seen refreshes once per position-storage interval (downsample.ts):
  // the window reaches back that much further, so a station still beaconing is never dropped from it
  const since = nowS() - maxAge - lastSeenLagS(env);
  const rows = (
    await env.DB.prepare(
      `SELECT s.callsign, s.lat, s.lon, s.symbol, s.course, s.speed_kn AS speedKn, s.altitude_m AS altitudeM,
            s.comment, s.last_seen AS lastSeen, a.roles AS roles
       FROM stations s LEFT JOIN account_stations a ON a.callsign = s.callsign
      WHERE s.lat IS NOT NULL AND s.last_seen >= ?${bb.sql}
      ORDER BY s.last_seen DESC LIMIT ?`,
    )
      .bind(since, ...bb.binds, limit)
      .all<{ roles: string | null }>()
  ).results;
  return json({ stations: rows.map((r) => ({ ...r, roles: rolesArr(r.roles) })) });
}

// ------------------------------------------------------------- transports (ports)
export async function handlePorts(_req: Request, env: Env): Promise<Response> {
  const since = nowS() - 24 * 3600;
  const rows = (
    await env.DB.prepare(
      `SELECT port, SUM(rx) AS rx, SUM(tx) AS tx, MAX(ts) AS lastBucket
       FROM port_stats WHERE ts >= ? GROUP BY port ORDER BY rx DESC`,
    )
      .bind(since)
      .all<{ port: string; rx: number; tx: number; lastBucket: number }>()
  ).results;
  return json({ window: "24h", ports: rows });
}

// ------------------------------------------------------------- messages (RX)
/** Where a sent message stands: waiting in the outbox, out on the air, acknowledged by the station, or not sent. */
type SentState = "queued" | "sent" | "acked" | "failed";

/**
 * Pure: the delivery state of a sent message. An ack the instance heard wins. A message sent through the instance
 * (it names an outbox row) is queued until the ingest box reports it sent on APRS-IS, and failed once it is older
 * than the outbox's queue lifetime without that: the box drains nothing older. Any other sent message went out on
 * the radio that recorded it.
 */
export function sentState(
  m: { ts: number; ackedAt?: number | null; outboxId?: number | null; sentAt?: number | null },
  now: number,
): SentState {
  if (m.ackedAt) return "acked";
  if (m.outboxId == null || m.sentAt) return "sent";
  return m.ts >= now - OUTBOX_QUEUED_TTL_S ? "queued" : "failed";
}

export async function handleMessages(req: Request, env: Env): Promise<Response> {
  const u = new URL(req.url);
  const pg = parsePage(u, 50, 200);
  const to = u.searchParams.get("to");
  const bulletins = u.searchParams.get("bulletins") === "1";
  // `call`: one operator's traffic, sent or received under any SSID of its base call. The service call shares
  // the sysop's base call but carries the instance's traffic (its answers, Mailbox deliveries), never the
  // sysop's own: a side that is the service call never makes a row theirs. A player's command to the service
  // call stays the player's, by its sending side.
  const callParam = u.searchParams.get("call");
  const base = callParam ? baseCall(callParam.trim().toUpperCase()) : null;
  if (callParam && !/^[A-Z0-9]{3,7}$/.test(base ?? ""))
    return json({ error: "call must be a callsign" }, { status: 400 });
  let sql =
    "SELECT id, ts, from_call AS fromCall, to_call AS toCall, body, direction, transport, ack, acked_at AS ackedAt, outbox_id AS outboxId, sent_at AS sentAt FROM messages WHERE 1=1";
  const binds: (string | number)[] = [];
  if (base) {
    sql += " AND (((from_call = ? OR from_call LIKE ?) AND from_call != ?)";
    sql += " OR ((to_call = ? OR to_call LIKE ?) AND IFNULL(to_call, '') != ?))";
    const service = serviceCall(env);
    binds.push(base, `${base}-%`, service, base, `${base}-%`, service);
  } else if (to) {
    sql += " AND to_call = ?";
    binds.push(to.toUpperCase());
  } else if (bulletins) {
    sql += " AND (to_call LIKE 'BLN%' OR to_call LIKE 'NWS%' OR to_call LIKE 'SKY%')";
  }
  const ks = keyset(pg.cursor, "ts", "id");
  sql += `${ks.sql} ORDER BY ts DESC, id DESC LIMIT ?`;
  binds.push(...ks.binds, pg.limit + 1);
  const rows = (
    await env.DB.prepare(sql)
      .bind(...binds)
      .all()
  ).results as any[];
  const page = paginate(rows, pg.limit, (r) => ({ primary: r.ts, id: r.id }));
  const now = nowS();
  return json({
    // an erased person's side reads as `WITHDRAWN`; a message they sent keeps its place with an empty body
    messages: page.items.map(({ ack, ackedAt, outboxId, sentAt, ...m }) => ({
      ...m,
      fromCall: m.fromCall == null ? m.fromCall : displayCall(m.fromCall),
      toCall: m.toCall == null ? m.toCall : displayCall(m.toCall),
      // a sent message carries its number and where it stands; a received one carries neither
      ...(m.direction === "tx"
        ? { msgNo: ack ?? null, delivery: sentState({ ts: m.ts, ackedAt, outboxId, sentAt }, now) }
        : {}),
    })),
    nextCursor: page.nextCursor,
    hasMore: page.hasMore,
    serviceCall: serviceCall(env),
  });
}

/**
 * POST /api/messages/sent — a message the signed-in operator's browser radio transmitted, recorded as `tx` so the
 * Messages list shows it as sent. Only from the operator's own verified call (any SSID), the same gate the
 * transmit itself has; the row is a record, the transmission happened on the radio.
 */
export async function handleSentMessage(req: Request, env: Env): Promise<Response> {
  const me = await sessionIdentity(req, env);
  if (!me) return json({ error: "sign in" }, { status: 401 });
  const b = (await req.json().catch(() => ({}))) as { from?: unknown; to?: unknown; text?: unknown; msgNo?: unknown };
  const from = typeof b.from === "string" ? b.from.trim().toUpperCase() : "";
  const to = typeof b.to === "string" ? b.to.trim().toUpperCase() : "";
  const text = typeof b.text === "string" ? b.text.trim().slice(0, 67) : "";
  const msgNo = typeof b.msgNo === "string" && /^[A-Za-z0-9]{1,5}$/.test(b.msgNo) ? b.msgNo : null;
  if (!/^[A-Z0-9]{1,6}(-[A-Z0-9]{1,2})?$/.test(from) || !/^[A-Z0-9-]{1,9}$/.test(to) || !text)
    return json({ error: "from, to and text required" }, { status: 400 });
  const own = await env.DB.prepare("SELECT 1 AS x FROM account_callsigns WHERE account_id = ? AND callsign = ?")
    .bind(me.accountId, baseCall(from))
    .first();
  if (!own) return json({ error: `${baseCall(from)} is not a callsign on your account` }, { status: 403 });
  if (!(await isCallsignVerified(env, from)))
    return json({ error: `verify ${baseCall(from)} to transmit — control-verification required` }, { status: 403 });
  // sent from the browser's own radio: the transport a signed browser batch records
  await env.DB.prepare(
    "INSERT INTO messages (ts, from_call, to_call, body, ack, direction, transport) VALUES (?,?,?,?,?, 'tx', 'browser-rf')",
  )
    .bind(nowS(), from, to, text, msgNo)
    .run();
  return json({ ok: true });
}

export async function handleStation(req: Request, env: Env, callsign: string): Promise<Response> {
  const cs = callsign.toUpperCase();
  const st = await env.DB.prepare(
    `SELECT s.callsign, s.lat, s.lon, s.symbol, s.course, s.speed_kn AS speedKn, s.altitude_m AS altitudeM,
            s.comment, s.last_seen AS lastSeen, a.roles AS roles, a.account_id AS owner
       FROM stations s LEFT JOIN account_stations a ON a.callsign = s.callsign WHERE s.callsign = ?`,
  )
    .bind(cs)
    .first<{ roles: string | null; owner: string | null }>();
  if (!st) return json({ error: "unknown station" }, { status: 404 });
  const { owner, ...station } = st;
  const stRoles = rolesArr(station.roles);
  // Whether the station is in an operator's registry, and whether that registry is the viewer's own, so
  // the panel offers "Add to my stations" only where adding can succeed. The owner's id never leaves.
  const registered = owner != null;
  const mine = registered && (await sessionIdentity(req, env))?.accountId === owner;

  const track = (
    await env.DB.prepare(
      "SELECT ts, lat, lon, heard_via AS heardVia FROM positions WHERE callsign = ? ORDER BY ts DESC LIMIT 50",
    )
      .bind(cs)
      .all()
  ).results;
  const wx = await env.DB.prepare(
    `SELECT ts, temp_c AS tempC, humidity, pressure_hpa AS pressureHpa,
            wind_dir AS windDirDeg, wind_kn AS windKn, rain_mm AS rainMm
       FROM sensor_readings WHERE station = ? ORDER BY ts DESC LIMIT 1`,
  )
    .bind(cs)
    .first();
  const pc = await env.DB.prepare("SELECT COUNT(*) AS n FROM positions WHERE callsign = ?")
    .bind(cs)
    .first<{ n: number }>();

  return json({
    station: { ...station, roles: stRoles, track, wx: wx ?? null, packets: pc?.n ?? 0, registered, mine },
  });
}

/**
 * Time-series for the shack station graphs. Two windowed series — the weather
 * readings and the motion telemetry (speed/altitude/course, historized on positions since 0029). Both
 * are ascending-by-ts (uPlot wants sorted x). The window is clamped so a busy station can't return an
 * unbounded set; default 24 h.
 */
export async function handleStationSeries(req: Request, env: Env, callsign: string): Promise<Response> {
  const cs = callsign.toUpperCase();
  const u = new URL(req.url);
  const DAY = 86_400;
  const windowSec = Math.min(Math.max(Number(u.searchParams.get("window")) || DAY, 3_600), 31 * DAY);
  const cap = 2_000;
  const since = nowS() - windowSec;

  const wx = (
    await env.DB.prepare(
      `SELECT ts, temp_c AS tempC, humidity, pressure_hpa AS pressureHpa, wind_kn AS windKn,
            gust_kn AS gustKn, rain_mm AS rainMm, rain_24h_mm AS rain24hMm
       FROM sensor_readings WHERE station = ? AND ts >= ? ORDER BY ts DESC LIMIT ?`,
    )
      .bind(cs, since, cap)
      .all()
  ).results.reverse();

  const motion = (
    await env.DB.prepare(
      `SELECT ts, speed_kn AS speedKn, altitude_m AS altitudeM, course
       FROM positions
      WHERE callsign = ? AND ts >= ? AND (speed_kn IS NOT NULL OR altitude_m IS NOT NULL OR course IS NOT NULL)
      ORDER BY ts DESC LIMIT ?`,
    )
      .bind(cs, since, cap)
      .all()
  ).results.reverse();

  return json({ callsign: cs, windowSec, wx, motion });
}

/**
 * Recent raw frames heard from a station — a shack diagnostic. Reconstructs
 * the TNC2 line (`src>dst,path:payload`) from the short-lived packets_recent ring. Newest first,
 * capped; the ring itself is TTL-pruned by the scheduled job, so this is inherently bounded.
 */
export async function handleStationPackets(req: Request, env: Env, callsign: string): Promise<Response> {
  const cs = callsign.toUpperCase();
  const u = new URL(req.url);
  const limit = Math.min(Math.max(Number(u.searchParams.get("limit")) || 50, 1), 200);
  const rows = (
    await env.DB.prepare(
      `SELECT ts, dst, path, payload, heard_via AS heardVia, port
       FROM packets_recent WHERE callsign = ? ORDER BY ts DESC LIMIT ?`,
    )
      .bind(cs, limit)
      .all()
  ).results as {
    ts: number;
    dst: string | null;
    path: string | null;
    payload: string | null;
    heardVia: string | null;
    port: string | null;
  }[];
  const packets = rows.map((r) => {
    const path = r.path ? `,${r.path}` : "";
    const tnc2 = `${cs}>${r.dst ?? "APRS"}${path}:${r.payload ?? ""}`;
    return { ts: r.ts, dst: r.dst, path: r.path, payload: r.payload, heardVia: r.heardVia, port: r.port, tnc2 };
  });
  return json({ callsign: cs, count: packets.length, packets });
}
