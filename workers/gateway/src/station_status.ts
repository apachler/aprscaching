// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * station_status.ts — GET /api/admin/station-status: a small read-only summary of what the station hears,
 * for the operator's own scripts (a phone notification, a field alert) and the sysop. Stations heard in
 * the last hour, packets per port in the current and previous hour (the counters are hourly buckets),
 * when each port last heard anything, and the direct messages received for the operator's own calls
 * (ADMIN_CALLSIGNS, any SSID) since a given time.
 *
 * Sysop or OPERATOR_SECRET only: message bodies are the operator's own mail, and nothing here is public.
 */
import type { Env } from "./env.js";
import { json } from "./app.js";
import { adminCalls, requireSysop } from "./admin.js";
import { nowS } from "./util/time.js";

const HOUR = 3600;
/** How far back `since` may reach, and how many messages one answer carries. */
const MAX_SINCE_AGE = 7 * 24 * HOUR;
const MAX_MESSAGES = 20;

export interface StationStatus {
  now: number;
  stationsLastHour: number;
  ports: { port: string; rxRecent: number; lastHeard: number | null }[];
  messages: { id: number; ts: number; from: string; to: string; body: string }[];
}

export async function handleStationStatus(req: Request, env: Env): Promise<Response> {
  const denied = await requireSysop(req, env, { allowOperatorSecret: true });
  if (denied) return denied;
  const now = nowS();
  const u = new URL(req.url);
  const sinceRaw = Number(u.searchParams.get("since"));
  const since = Number.isFinite(sinceRaw) && sinceRaw > 0 ? Math.max(sinceRaw, now - MAX_SINCE_AGE) : now - HOUR;

  const stations = await env.DB.prepare("SELECT COUNT(*) AS n FROM stations WHERE last_seen >= ?")
    .bind(now - HOUR)
    .first<{ n: number }>();

  // port_stats buckets by the hour: the current and the previous bucket.
  const rx = (
    await env.DB.prepare("SELECT port, SUM(rx) AS rx FROM port_stats WHERE ts >= ? GROUP BY port")
      .bind(now - 2 * HOUR)
      .all<{ port: string; rx: number }>()
  ).results;
  const heard = (
    await env.DB.prepare(
      "SELECT port, MAX(ts) AS lastHeard FROM packets_recent WHERE port IS NOT NULL GROUP BY port",
    ).all<{ port: string; lastHeard: number }>()
  ).results;
  const ports = new Map<string, { port: string; rxRecent: number; lastHeard: number | null }>();
  for (const r of rx) ports.set(r.port, { port: r.port, rxRecent: r.rx ?? 0, lastHeard: null });
  for (const h of heard) {
    const p = ports.get(h.port) ?? { port: h.port, rxRecent: 0, lastHeard: null };
    p.lastHeard = h.lastHeard;
    ports.set(h.port, p);
  }

  // Received messages to any SSID of the operator's calls.
  const calls = [...adminCalls(env)].map((c) => c.replace(/-\d{1,2}$/, ""));
  let messages: StationStatus["messages"] = [];
  if (calls.length) {
    const match = calls.map(() => "(UPPER(to_call) = ? OR UPPER(to_call) LIKE ?)").join(" OR ");
    const binds = calls.flatMap((c) => [c, `${c}-%`]);
    messages = (
      await env.DB.prepare(
        `SELECT id, ts, from_call AS "from", to_call AS "to", body FROM messages
          WHERE direction = 'rx' AND ts > ? AND (${match}) ORDER BY ts ASC, id ASC LIMIT ?`,
      )
        .bind(since, ...binds, MAX_MESSAGES)
        .all<StationStatus["messages"][number]>()
    ).results;
  }

  const body: StationStatus = {
    now,
    stationsLastHour: stations?.n ?? 0,
    ports: [...ports.values()].sort((a, b) => a.port.localeCompare(b.port)),
    messages,
  };
  return json(body);
}
