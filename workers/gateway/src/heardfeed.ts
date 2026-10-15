// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * heardfeed.ts — the station-health feed of the read API: when a watched callsign was last heard, so a
 * Node-RED flow or a home-automation box watches a station without scraping APRS-IS.
 *
 *   GET /api/v1/station/:call/heard              the latest snapshot (cacheable, `?since=` cursor, ETag)
 *   GET /api/v1/stations/heard/stream?calls=A,B  Server-Sent Events: a `snapshot` per call, then a `heard`
 *                                                event per packet of a watched call
 *
 * The stream is a listener on the live map's in-memory rooms (rooms-core.ts `listen`): the ingest dispatches a
 * heard envelope per transmission beside the station deltas, and the stream filters those. Nothing polls the
 * database and nothing is written per packet. Both routes carry only what the station put on the air — its
 * position, path, comment and status text — never an account, owner or registry field.
 */
import { baseCall, decodeAprs } from "@aprscaching/aprs";
import {
  HEARD_STREAM_KEEPALIVE_SEC,
  HEARD_STREAM_MAX_CALLS,
  HEARD_STREAM_MAX_OPEN,
  type HeardEvent,
  type HeardVia,
  type StationHeard,
} from "@aprscaching/shared";
import type { Env } from "./env.js";
import { json } from "./http.js";
import { LIVE_REGION, type LiveEnvelope } from "./live.js";

/** How long one stream lives before the client reconnects (EventSource does so on its own). */
const STREAM_MAX_MS = 30 * 60_000;
/** Milliseconds the client waits before it reconnects, sent as the stream's `retry:` field. */
const RETRY_MS = 5_000;
/** Frames queued to a client that does not read, past which the stream is closed. */
const MAX_QUEUED = 500;
/** How long the snapshot route may be cached, in seconds. */
const SNAPSHOT_MAX_AGE = 15;

/** A callsign as the feed takes it: a base call of up to nine characters, an optional SSID. */
const CALL_RE = /^[A-Z0-9]{1,9}(-[A-Z0-9]{1,2})?$/;

/** The callsign in canonical form, or null when it is not one. */
export function feedCall(raw: string): string | null {
  const cs = raw.trim().toUpperCase();
  return CALL_RE.test(cs) ? cs : null;
}

/** The `calls=` list of a stream: each callsign once, at most {@link HEARD_STREAM_MAX_CALLS}. */
export function parseCalls(raw: string | null): string[] | { error: string } {
  const parts = (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!parts.length) return { error: "name the callsigns to watch: ?calls=CALL1,CALL2" };
  const calls = new Set<string>();
  for (const p of parts) {
    const cs = feedCall(p);
    if (!cs) return { error: `not a callsign: ${p.slice(0, 20)}` };
    calls.add(cs);
  }
  if (calls.size > HEARD_STREAM_MAX_CALLS)
    return { error: `watch at most ${HEARD_STREAM_MAX_CALLS} callsigns per stream` };
  return [...calls];
}

/**
 * Whether a watch list covers `callsign`: a call with an SSID matches itself, one without matches every SSID of
 * that base call (as the watchlist does).
 */
export function watches(calls: readonly string[], callsign: string): boolean {
  const cs = callsign.toUpperCase();
  const base = baseCall(cs);
  return calls.some((c) => c === cs || (!c.includes("-") && c === base));
}

/**
 * The heard event of one ingested packet. `fix` is its decoded position, if any; only the station's own position
 * is reported (an object or item it sent stands somewhere else).
 */
export function heardEventOf(
  p: { src: string; ts: number; heardVia: HeardVia; path: string[] },
  data: { kind?: string; text?: unknown },
  fix: { lat: number; lon: number; symbol?: string; course?: number; speedKn?: number; own: boolean } | null,
): HeardEvent {
  const ev: HeardEvent = { type: "heard", callsign: p.src.toUpperCase(), ts: p.ts, via: p.heardVia, path: p.path };
  if (fix?.own) {
    ev.position = { lat: fix.lat, lon: fix.lon };
    if (fix.symbol !== undefined) ev.position.symbol = fix.symbol;
    if (fix.course !== undefined) ev.position.course = fix.course;
    if (fix.speedKn !== undefined) ev.position.speedKn = fix.speedKn;
  }
  if (data.kind === "status" && typeof data.text === "string") ev.status = data.text;
  return ev;
}

/** One Server-Sent Events frame. */
export function sseFrame(event: string, data: unknown, id?: number): string {
  return `event: ${event}\n${id !== undefined ? `id: ${id}\n` : ""}data: ${JSON.stringify(data)}\n\n`;
}

const viaOf = (v: string | null | undefined): HeardVia | null =>
  v === "rf" || v === "aprs_is" || v === "app" ? v : null;
const pathOf = (v: string | null | undefined): string[] => (v ? v.split(",").filter(Boolean) : []);

/**
 * The latest of one station: its stored position and comment (the `stations` row), the route and time of its
 * latest packet (the raw-packet ring, else the latest stored position) and its latest status report.
 */
async function stationHeard(env: Env, cs: string, since: number | null): Promise<StationHeard> {
  const [st, pkt, status] = await Promise.all([
    env.DB.prepare(
      `SELECT lat, lon, symbol, course, speed_kn AS speedKn, comment, last_seen AS lastSeen
         FROM stations WHERE callsign = ?`,
    )
      .bind(cs)
      .first<{
        lat: number | null;
        lon: number | null;
        symbol: string | null;
        course: number | null;
        speedKn: number | null;
        comment: string | null;
        lastSeen: number | null;
      }>(),
    env.DB.prepare(
      "SELECT ts, path, heard_via AS heardVia FROM packets_recent WHERE callsign = ? ORDER BY ts DESC, id DESC LIMIT 1",
    )
      .bind(cs)
      .first<{ ts: number; path: string | null; heardVia: string | null }>(),
    env.DB.prepare(
      `SELECT ts, payload FROM packets_recent WHERE callsign = ? AND substr(payload, 1, 1) = '>'
        ORDER BY ts DESC, id DESC LIMIT 1`,
    )
      .bind(cs)
      .first<{ ts: number; payload: string }>(),
  ]);
  // the ring is short-lived: past it, the route of the latest stored position
  const route =
    pkt ??
    (await env.DB.prepare(
      "SELECT ts, path, heard_via AS heardVia FROM positions WHERE callsign = ? ORDER BY ts DESC, id DESC LIMIT 1",
    )
      .bind(cs)
      .first<{ ts: number; path: string | null; heardVia: string | null }>());
  const position =
    st && st.lat != null && st.lon != null && st.lastSeen != null
      ? {
          lat: st.lat,
          lon: st.lon,
          ...(st.symbol != null ? { symbol: st.symbol } : {}),
          ...(st.course != null ? { course: st.course } : {}),
          ...(st.speedKn != null ? { speedKn: st.speedKn } : {}),
          ts: st.lastSeen,
        }
      : null;
  let statusText: StationHeard["status"] = null;
  if (status) {
    const d = decodeAprs({ src: cs, dst: "", path: [], payload: status.payload, raw: "" }) as {
      kind?: string;
      text?: unknown;
    };
    if (d.kind === "status" && typeof d.text === "string") statusText = { text: d.text, ts: status.ts };
  }
  const times = [route?.ts, position?.ts, statusText?.ts].filter((t): t is number => typeof t === "number");
  const lastHeard = times.length ? Math.max(...times) : null;
  return {
    callsign: cs,
    lastHeard,
    via: viaOf(route?.heardVia),
    path: pathOf(route?.path),
    position,
    comment: st?.comment ?? null,
    status: statusText,
    cursor: lastHeard ?? 0,
    changed: since == null || (lastHeard ?? 0) > since,
  };
}

/** GET /api/v1/station/:call/heard — the snapshot; `If-None-Match` with the last ETag answers 304. */
export async function handleStationHeard(req: Request, env: Env, rawCall: string): Promise<Response> {
  const cs = feedCall(rawCall);
  if (!cs) return json({ error: "not a callsign" }, { status: 400 });
  const sinceRaw = new URL(req.url).searchParams.get("since");
  const since = sinceRaw == null || sinceRaw === "" ? null : Number(sinceRaw);
  if (since != null && !Number.isFinite(since))
    return json({ error: "since must be the cursor of an earlier answer" }, { status: 400 });
  const body = await stationHeard(env, cs, since);
  const etag = `W/"heard-${cs}-${body.cursor}"`;
  const headers = { "cache-control": `public, max-age=${SNAPSHOT_MAX_AGE}`, etag };
  if (req.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers });
  return json(body, { headers });
}

/**
 * GET /api/v1/stations/heard/stream?calls= — Server-Sent Events. Opens with a `retry:` field and a `snapshot`
 * event per call, then pushes a `heard` event for each packet of a watched call as the ingest dispatches it, with
 * a keep-alive comment every {@link HEARD_STREAM_KEEPALIVE_SEC} seconds. It closes after thirty minutes (the
 * client reconnects), when the client goes away, or when the client stops reading. `holder` is the API key or the
 * client address, which bounds the streams open at once.
 */
export function handleHeardStream(req: Request, env: Env, holder: string, keyed: boolean): Response {
  const calls = parseCalls(new URL(req.url).searchParams.get("calls"));
  if (!Array.isArray(calls)) return json(calls, { status: 400 });
  const rooms = env.ROOMS;
  if (!rooms.listen || !rooms.holding)
    return json({ error: "the heard stream needs the live rooms of a Node or Bun server" }, { status: 503 });
  const max = keyed ? HEARD_STREAM_MAX_OPEN.keyed : HEARD_STREAM_MAX_OPEN.anonymous;
  if (rooms.holding(holder) >= max)
    return json(
      { error: `at most ${max} streams open at once${keyed ? " per key" : "; a free key allows more"}` },
      { status: 429, headers: { "retry-after": "60" } },
    );

  const enc = new TextEncoder();
  let finish = () => {};
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let done = false;
      const send = (s: string) => {
        if (done) return;
        if ((controller.desiredSize ?? 0) < -MAX_QUEUED) return finish(); // the client stopped reading
        try {
          controller.enqueue(enc.encode(s));
        } catch {
          finish();
        }
      };
      // listen first, so nothing heard while the snapshot is read is missed
      const unlisten = rooms.listen!(LIVE_REGION, holder, (envelopes) => {
        for (const e of envelopes as LiveEnvelope[])
          if (e.heard && watches(calls, e.heard.callsign)) send(sseFrame("heard", e.heard, e.heard.ts));
      });
      const keepAlive = setInterval(() => send(`: keep-alive\n\n`), HEARD_STREAM_KEEPALIVE_SEC * 1000);
      const lifetime = setTimeout(() => finish(), STREAM_MAX_MS);
      finish = () => {
        if (done) return;
        done = true;
        unlisten();
        clearInterval(keepAlive);
        clearTimeout(lifetime);
        req.signal?.removeEventListener("abort", finish);
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };
      req.signal?.addEventListener("abort", finish);
      send(`retry: ${RETRY_MS}\n\n`);
      void (async () => {
        for (const cs of calls) {
          if (done) return;
          try {
            send(sseFrame("snapshot", await stationHeard(env, cs, null)));
          } catch {
            /* a failed snapshot leaves the live events */
          }
        }
      })();
    },
    cancel() {
      finish();
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no", // no proxy buffering (nginx), so each event leaves at once
    },
  });
}
