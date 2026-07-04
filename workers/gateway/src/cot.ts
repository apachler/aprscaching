// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * cot.ts — M6 interop: a Cursor-on-Target (CoT) bridge so TAK clients (ATAK/WinTAK/iTAK) can
 * consume our live APRS station registry. CoT is an open MITRE schema; we map each station to an
 * <event> and return a snapshot <events> document over a bbox. Pure builder + a thin handler so the
 * mapping is conformance-tested on both runtimes.
 */
import type { Env } from "./env.js";

interface CotStation {
  callsign: string;
  lat: number;
  lon: number;
  symbol: string | null;
  course: number | null;
  speedKn: number | null;
  altitudeM: number | null;
  comment: string | null;
  lastSeen: number;
}

const UNK = 9999999.0; // CoT "unknown" sentinel for hae/ce/le
const KN_TO_MS = 0.514444;
const iso = (sec: number) => new Date(sec * 1000).toISOString();
const xml = (s: string) =>
  s.replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c]!);

/** Map an APRS symbol (table+code) to a coarse CoT 2525-ish type. Friendly by default. */
export function cotType(symbol: string | null): string {
  const code = symbol && symbol.length >= 2 ? symbol[1] : symbol?.[0];
  switch (code) {
    case ">":
    case "<":
    case "j":
    case "k":
    case "u":
    case "v":
    case "=":
      return "a-f-G-E-V-C"; // ground vehicle
    case "^":
    case "'":
    case "X":
    case "g":
    case "O":
      return "a-f-A"; // aircraft
    case "Y":
    case "s":
    case "C":
      return "a-f-S"; // surface/marine
    case "_":
    case "W":
      return "a-f-G-I-U-T"; // weather/sensor
    case "#":
    case "r":
      return "a-f-G-I-U-R"; // infrastructure (digi/repeater)
    default:
      return "a-f-G-U-C"; // generic friendly ground combat unit
  }
}

/** Build a single CoT <event> for a station. `now` = current unix seconds. */
export function stationToCotEvent(s: CotStation, now: number, staleSec = 300): string {
  const hae = s.altitudeM != null ? s.altitudeM.toFixed(1) : UNK.toFixed(1);
  const detail: string[] = [`<contact callsign="${xml(s.callsign)}"/>`];
  if (s.course != null || s.speedKn != null)
    detail.push(`<track course="${s.course ?? 0}" speed="${((s.speedKn ?? 0) * KN_TO_MS).toFixed(2)}"/>`);
  detail.push(`<remarks>${xml(`APRS ${s.symbol ?? ""}${s.comment ? ` ${s.comment}` : ""}`.trim())}</remarks>`);
  return (
    `<event version="2.0" uid="APRS.${xml(s.callsign)}" type="${cotType(s.symbol)}"` +
    ` time="${iso(now)}" start="${iso(s.lastSeen)}" stale="${iso(s.lastSeen + staleSec)}" how="m-g">` +
    `<point lat="${s.lat}" lon="${s.lon}" hae="${hae}" ce="${UNK}" le="${UNK}"/>` +
    `<detail>${detail.join("")}</detail></event>`
  );
}

/** Parse a `bbox=minLon,minLat,maxLon,maxLat` query param, or undefined when absent/malformed. */
function parseBbox(u: URL): [number, number, number, number] | undefined {
  const b = u.searchParams.get("bbox");
  if (!b) return undefined;
  const p = b.split(",").map(Number);
  if (p.length >= 4 && !p.some(Number.isNaN)) return [p[0]!, p[1]!, p[2]!, p[3]!];
  return undefined;
}

/**
 * Query stations for CoT emission. `condition`/`bind` select rows (a recency floor for the snapshot,
 * a strict cursor for deltas); `bbox` narrows to the viewport. Newest first for the snapshot, oldest
 * first for deltas so the caller can advance a monotonic cursor.
 */
async function cotStations(
  env: Env,
  condition: string,
  bind: number,
  bbox: [number, number, number, number] | undefined,
  order: "ASC" | "DESC",
  limit: number,
): Promise<CotStation[]> {
  let where = `lat IS NOT NULL AND ${condition}`;
  const binds: number[] = [bind];
  if (bbox) {
    const [minLon, minLat, maxLon, maxLat] = bbox;
    where += " AND lat BETWEEN ? AND ? AND lon BETWEEN ? AND ?";
    binds.push(minLat, maxLat, minLon, maxLon);
  }
  return (
    await env.DB.prepare(
      `SELECT callsign, lat, lon, symbol, course, speed_kn AS speedKn, altitude_m AS altitudeM,
            comment, last_seen AS lastSeen FROM stations WHERE ${where} ORDER BY last_seen ${order} LIMIT ?`,
    )
      .bind(...binds, limit)
      .all<CotStation>()
  ).results;
}

export async function handleCot(req: Request, env: Env, now: number): Promise<Response> {
  const u = new URL(req.url);
  const maxAge = Math.min(Math.max(Number(u.searchParams.get("maxAge") ?? 3600) || 3600, 60), 86400);
  const rows = await cotStations(env, "last_seen >= ?", now - maxAge, parseBbox(u), "DESC", 2000);
  const body = `<?xml version="1.0" encoding="UTF-8"?>\n<events>${rows.map((r) => stationToCotEvent(r, now)).join("")}</events>`;
  return new Response(body, { headers: { "content-type": "application/xml; charset=utf-8" } });
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * GET /api/cot/stream — a Server-Sent Events CoT feed so TAK clients (ATAK/WinTAK) get PUSH updates,
 * not just the /api/cot bbox snapshot. On connect we emit the current snapshot as `event: cot`
 * frames, then poll for stations heard since a monotonic cursor and push each as it arrives, with a
 * `: ping` heartbeat every cycle. The stream ends after `maxMs` (the client reconnects) or when the
 * client disconnects (req.signal abort / stream cancel). Runtime-neutral: the response is a
 * ReadableStream — Workers/Bun stream it natively; the Node shell pipes text/event-stream bodies.
 */
export function handleCotStream(req: Request, env: Env, now: number): Response {
  const u = new URL(req.url);
  const bbox = parseBbox(u);
  const maxAge = Math.min(Math.max(Number(u.searchParams.get("maxAge") ?? 3600) || 3600, 60), 86400);
  const intervalMs = Math.min(Math.max(Number(env.COT_STREAM_INTERVAL_MS ?? 15000) || 15000, 1000), 120000);
  const maxMs = Math.min(Math.max(Number(env.COT_STREAM_MAX_MS ?? 300000) || 300000, 10000), 3600000);
  const enc = new TextEncoder();
  let closed = false;
  const stop = () => {
    closed = true;
  };
  req.signal?.addEventListener("abort", stop);

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (s: string) => {
        try {
          controller.enqueue(enc.encode(s));
        } catch {
          closed = true; // controller closed / errored
        }
      };
      void (async () => {
        const startedMs = Date.now();
        // snapshot of currently-active stations
        const snap = await cotStations(env, "last_seen >= ?", now - maxAge, bbox, "DESC", 2000);
        for (const r of snap) send(`event: cot\ndata: ${stationToCotEvent(r, now)}\n\n`);
        send(`: snapshot ${snap.length}\n\n`);
        let cursor = now; // deltas = stations heard strictly after connect
        while (!closed && Date.now() - startedMs < maxMs) {
          await sleep(intervalMs);
          if (closed) break;
          const nowS = Math.floor(Date.now() / 1000);
          const rows = await cotStations(env, "last_seen > ?", cursor, bbox, "ASC", 500);
          for (const r of rows) {
            send(`event: cot\ndata: ${stationToCotEvent(r, nowS)}\n\n`);
            if (r.lastSeen > cursor) cursor = r.lastSeen;
          }
          send(`: ping ${nowS}\n\n`);
        }
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      })();
    },
    cancel() {
      stop();
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no", // disable proxy buffering (nginx) so events flush immediately
    },
  });
}
