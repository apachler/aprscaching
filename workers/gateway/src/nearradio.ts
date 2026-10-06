// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * nearradio.ts — the "you're near" radio message, for hunting without the app. When the ingest hears a
 * player's own station within the geofence of a cache (live.ts), the service call sends that station a short
 * APRS message naming the cache, its distance and its direction, e.g.
 * `Near AC-1234 Landhaus courtyard 40m NE. Reply FOUND AC-1234`.
 *
 * It is opt-in per account and off by default, switched in Settings or by `NEAR ON` / `NEAR OFF` sent to the
 * service call (radiolog.ts). A station gets it only when:
 *
 *  - its base call is a control-verified callsign of an account that switched it on — never a station that
 *    is merely heard, and never a call an account holds without proving control of it;
 *  - the fix is the station's own position (not an object, item or weather report) moving slower than
 *    {@link SLOW_KMH}; a fix without a speed counts as slow;
 *  - the cache is active and listed, and the account neither owns it nor has found it;
 *  - the person had no message for that cache in the last day and fewer than {@link PER_HOUR} in the last
 *    hour, whatever SSID they used.
 *
 * The message goes back the way the station was heard, through the same path as the Mailbox
 * (mailbox.ts {@link sendToHeard}): the box that heard it on its own radio, the MeshCom node that heard it,
 * or the APRS-IS outbox. It is numbered so the station's radio shows and acks it, and is sent once: a
 * position minutes later is a new occasion. It is advice only — it changes no trust tier, and a FOUND sent in
 * reply is a radio command verified like any other.
 */
import { baseCall } from "@aprscaching/aprs";
import type { Env } from "./env.js";
import { json } from "./http.js";
import { nowS } from "./util/time.js";
import { sessionIdentity } from "./auth.js";
import { isCallsignVerified } from "./callsign.js";
import { serviceCall } from "./servicecall.js";
import { rateLimitedDurable } from "./corroborate_privacy.js";
import { sendToHeard, type Heard } from "./mailbox.js";
import type { NearCache } from "./live.js";

/** A fix at or above this speed is a station driving past, not a player on the hunt. */
const SLOW_KMH = 10;
const SLOW_KN = SLOW_KMH / 1.852;
/** Messages one person may get an hour. */
const PER_HOUR = 4;
/** One message per person and cache in this window; rows older than it are pruned. */
const PER_CACHE_SEC = 24 * 3600;
/** Near-cache messages the service call sends an hour across all stations. */
const SERVICE_PER_HOUR = 200;
/** The APRS message text limit. */
const APRS_TEXT_MAX = 67;

/** Printable ASCII only, without the APRS-reserved `|`, `~` and `{`. */
const clean = (s: string) =>
  s
    .replace(/[‐-―]/g, "-")
    .replace(/[^\x20-\x7e]/g, "")
    .replace(/[|~{]/g, "")
    .replace(/\s+/g, " ")
    .trim();

const POINTS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"] as const;

/** The initial bearing from one point to another, in degrees from north. */
export function bearingDeg(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const r = Math.PI / 180;
  const y = Math.sin((lon2 - lon1) * r) * Math.cos(lat2 * r);
  const x =
    Math.cos(lat1 * r) * Math.sin(lat2 * r) - Math.sin(lat1 * r) * Math.cos(lat2 * r) * Math.cos((lon2 - lon1) * r);
  return (((Math.atan2(y, x) / r) % 360) + 360) % 360;
}

/** A bearing as one of eight compass points. */
export const compassPoint = (deg: number): string => POINTS[Math.round(deg / 45) % 8]!;

/**
 * The message text, at most {@link APRS_TEXT_MAX} characters: the title is trimmed to fit, and dropped when
 * nothing of it fits. A code too long for the reply hint keeps the code, distance and direction.
 */
export function nearText(code: string, title: string, distanceM: number, bearing: number, more: number): string {
  const where = `${Math.round(distanceM)}m ${compassPoint(bearing)}${more > 0 ? ` +${more} more` : ""}`;
  const tail = `${where}. Reply FOUND ${code}`;
  const bare = `Near ${code} ${tail}`;
  if (bare.length > APRS_TEXT_MAX) return `Near ${code} ${where}`.slice(0, APRS_TEXT_MAX);
  const room = APRS_TEXT_MAX - bare.length - 1;
  const t = clean(title).slice(0, room).trim();
  return t ? `Near ${code} ${t} ${tail}` : bare;
}

/** A message number of its own: `N` and four base-36 characters, apart from the Mailbox's numbers. */
const msgNoNow = () => `N${(nowS() % 36 ** 4).toString(36).toUpperCase().padStart(4, "0")}`;

/** One fix of the batch near at least one cache, and the route back to its station. */
export interface NearFix {
  heard: Heard;
  lat: number;
  lon: number;
  speedKn?: number;
  near: NearCache[];
}

/** Is the fix slow enough for a player on foot? A fix without a speed counts as slow. */
export const isSlow = (speedKn?: number) => speedKn == null || speedKn < SLOW_KN;

/**
 * Send the near-cache messages a batch earns. Costs nothing unless a fix is near a cache; then one read
 * finds the opted-in accounts among those stations, and only a station that gets a message costs more.
 */
export async function sendNearCacheMessages(env: Env, fixes: NearFix[]): Promise<void> {
  const service = serviceCall(env);
  // the latest slow fix per person
  const byBase = new Map<string, NearFix>();
  for (const f of fixes) {
    const src = f.heard.src.toUpperCase();
    if (!f.near.length || !isSlow(f.speedKn) || src === service) continue;
    byBase.set(baseCall(src), f);
  }
  if (!byBase.size) return;
  const bases = [...byBase.keys()];
  const marks = bases.map(() => "?").join(",");
  const optedIn = (
    await env.DB.prepare(
      `SELECT ac.callsign, ac.account_id FROM account_callsigns ac JOIN accounts a ON a.account_id = ac.account_id
        WHERE a.near_radio = 1 AND ac.callsign IN (${marks})`,
    )
      .bind(...bases)
      .all<{ callsign: string; account_id: string }>()
  ).results;
  if (!optedIn.length) return;
  const now = nowS();
  const recent = (
    await env.DB.prepare(
      `SELECT call, cache_id, sent_at FROM near_cache_messages WHERE call IN (${optedIn.map(() => "?").join(",")}) AND sent_at > ?`,
    )
      .bind(...optedIn.map((o) => o.callsign), now - PER_CACHE_SEC)
      .all<{ call: string; cache_id: number; sent_at: number }>()
  ).results;

  for (const { callsign: base, account_id: accountId } of optedIn) {
    const f = byBase.get(base)!;
    const mine = recent.filter((r) => r.call === base);
    if (mine.filter((r) => r.sent_at > now - 3600).length >= PER_HOUR) continue;
    if (!(await isCallsignVerified(env, base))) continue;
    // caches the account owns or has found, under any of its calls and SSIDs
    const ids = f.near.map((c) => c.id);
    const skip = new Set(
      (
        await env.DB.prepare(
          `SELECT c.id FROM caches c WHERE c.id IN (${ids.map(() => "?").join(",")}) AND (
             EXISTS (SELECT 1 FROM account_callsigns ac WHERE ac.account_id = ?
                      AND (c.owner_call = ac.callsign OR c.owner_call LIKE ac.callsign || '-%'))
             OR EXISTS (SELECT 1 FROM cache_logs l JOIN account_callsigns ac ON ac.account_id = ?
                         WHERE l.cache_id = c.id AND l.log_type = 'found'
                           AND (l.logger_call = ac.callsign OR l.logger_call LIKE ac.callsign || '-%')))`,
        )
          .bind(...ids, accountId, accountId)
          .all<{ id: number }>()
      ).results.map((r) => r.id),
    );
    const open = f.near.filter((c) => !skip.has(c.id)).sort((a, b) => a.distanceM - b.distanceM);
    const sent = new Set(mine.map((r) => r.cache_id));
    const c = open.find((x) => !sent.has(x.id));
    if (!c) continue;
    if (await rateLimitedDurable(env, "radio:near", Date.now(), SERVICE_PER_HOUR, 3600_000)) return;
    const text = nearText(c.code, c.title, c.distanceM, bearingDeg(f.lat, f.lon, c.lat, c.lon), open.length - 1);
    const msgNo = msgNoNow();
    if (!(await sendToHeard(env, f.heard, text, msgNo))) continue;
    await env.DB.prepare(
      `INSERT INTO near_cache_messages (call, cache_id, station, msg_no, sent_at) VALUES (?,?,?,?,?)
       ON CONFLICT(call, cache_id) DO UPDATE SET station = excluded.station, msg_no = excluded.msg_no,
         sent_at = excluded.sent_at, acked_at = NULL`,
    )
      .bind(base, c.id, f.heard.src.toUpperCase(), msgNo, now)
      .run();
  }
}

/** An ack to the service call for a near-cache message. A MeshCom ExtUDP ack carries the node's number, not ours. */
export async function nearOnAck(env: Env, from: string, msgNo: string, port: string): Promise<void> {
  if (port === "meshcom" || !/^N/i.test(msgNo)) return;
  await env.DB.prepare(
    "UPDATE near_cache_messages SET acked_at = ? WHERE call = ? AND station = ? AND msg_no = ? AND acked_at IS NULL",
  )
    .bind(nowS(), baseCall(from.toUpperCase()), from.toUpperCase(), msgNo.toUpperCase())
    .run();
}

/** Daily: forget what was sent more than a day ago; the limits no longer need it. */
export async function pruneNearCacheMessages(env: Env): Promise<void> {
  await env.DB.prepare("DELETE FROM near_cache_messages WHERE sent_at <= ?")
    .bind(nowS() - PER_CACHE_SEC)
    .run();
}

/** Switch the account's near-cache radio message. */
export async function setNearRadio(env: Env, accountId: string, on: boolean): Promise<void> {
  await env.DB.prepare("UPDATE accounts SET near_radio = ? WHERE account_id = ?")
    .bind(on ? 1 : 0, accountId)
    .run();
}

/** GET / POST /api/near-radio {on} — the signed-in account's opt-in to the near-cache radio message. */
export async function handleNearRadioPrefs(req: Request, env: Env): Promise<Response> {
  const me = await sessionIdentity(req, env);
  if (!me) return json({ error: "sign in" }, { status: 401 });
  if (req.method === "POST") {
    const b = (await req.json().catch(() => ({}))) as { on?: unknown };
    if (typeof b.on !== "boolean") return json({ error: "on must be true or false" }, { status: 400 });
    await setNearRadio(env, me.accountId, b.on);
  }
  const row = await env.DB.prepare("SELECT near_radio FROM accounts WHERE account_id = ?")
    .bind(me.accountId)
    .first<{ near_radio: number }>();
  return json({ on: (row?.near_radio ?? 0) === 1 });
}
