// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * meshcom.ts — MeshCom as the operator's own node(s) observe it, stored for the map.
 *
 * Each MeshCom packet from a trusted ingest carries `parsed.meshcom` (packages/shared meshcom.ts): how the
 * receiving node got the frame, the signal of a LoRa hearing, the sender's device. This keeps the latest
 * state of each node heard (`meshcom_nodes`) and the links between nodes (`meshcom_links`): a direct
 * hearing is one link, origin → receiver; a relayed frame gives each leg of its path, and only the last
 * leg, into the receiver, carries a signal report. A frame the MeshCom server relayed adds no link: it
 * says nothing about who hears whom on the air around this operator. Links come from the source path and the
 * receiver only, never from a message's via list: that names the relays its sender allowed, not the ones a
 * frame took. A node's latest via list is kept as display information on its row (`sent_via`).
 *
 * Writes stay small: one row per node and per link, rewritten only when a shown value changes (device,
 * firmware, a 10 % battery step, how it was heard, the receiver, the signal quality) or once
 * MESHCOM_META_MIN_S seconds have passed. A link's signal is a rolling average of its recent samples.
 * All of it is display information: nothing here is read by the trust derivation.
 */
import type { Env } from "./env.js";
import type { SqlStatement } from "./runtime.js";
import { meshcomBattLevel, meshcomQuality, type MeshcomMeta } from "@aprscaching/shared";
import { json } from "./app.js";
import { sessionIdentity } from "./auth.js";
import { nowS } from "./util/time.js";
import { parsePage, keyset, paginate } from "./paging.js";

/** How a node was last heard, as the map shows it. */
type MeshcomVia = "direct" | "relayed" | "server" | "node";

/** A MeshCom packet's sender, when it was heard, and what the ingest reported about it. */
export interface MeshcomObservation {
  src: string;
  ts: number;
  meta: MeshcomMeta;
}

/** Samples a link's rolling signal average spans. */
const LINK_WINDOW = 8;

const intEnv = (v: string | undefined, dflt: number, min: number) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= min ? Math.floor(n) : dflt;
};
/** The per-node and per-link rewrite interval, seconds. */
const metaMinS = (env: Env) => intEnv(env.MESHCOM_META_MIN_S, 300, 0);

/** How the receiving node got a frame: straight over LoRa, relayed over LoRa, from the MeshCom server, or its own. */
export function meshcomVia(src: string, m: MeshcomMeta): MeshcomVia {
  if (m.srcType === "udp") return "server";
  if (m.srcType === "node") return "node";
  if (m.srcType === "lora" && m.receiver !== src) {
    if (m.direct) return "direct";
    if ((m.path?.length ?? 0) > 1) return "relayed";
  }
  return "node";
}

interface Link {
  from: string;
  to: string;
  kind: "direct" | "relay";
  rssi?: number;
  snr?: number;
}

/** The links one LoRa hearing shows: origin → receiver, or each leg of the relay path into the receiver. */
function meshcomLinks(src: string, m: MeshcomMeta): Link[] {
  if (m.srcType !== "lora" || !m.receiver || m.receiver === src) return [];
  const signal = { ...(m.rssi != null ? { rssi: m.rssi } : {}), ...(m.snr != null ? { snr: m.snr } : {}) };
  if (m.direct) return [{ from: src, to: m.receiver, kind: "direct", ...signal }];
  const path = m.path ?? [];
  if (path.length < 2 || path[0] !== src) return [];
  const hops = [...path, m.receiver];
  const legs: Link[] = [];
  for (let i = 0; i + 1 < hops.length; i++) {
    if (hops[i] === hops[i + 1]) continue;
    const last = i + 2 === hops.length;
    legs.push({ from: hops[i]!, to: hops[i + 1]!, kind: "relay", ...(last ? signal : {}) });
  }
  return legs;
}

/** The statements that record a batch's MeshCom observations; empty when there are none. */
export function meshcomStatements(env: Env, obs: MeshcomObservation[]): SqlStatement[] {
  if (!obs.length) return [];
  const minS = metaMinS(env);
  // one node row per sender per batch: later fields win, a missing field keeps the earlier one
  const nodes = new Map<string, { ts: number; meta: MeshcomMeta; via: MeshcomVia; msgAt: number | null }>();
  const links = new Map<string, Link & { ts: number; receiver: string }>();
  for (const o of [...obs].sort((a, b) => a.ts - b.ts)) {
    const prev = nodes.get(o.src);
    nodes.set(o.src, {
      ts: o.ts,
      meta: { ...(prev?.meta ?? {}), ...o.meta },
      via: meshcomVia(o.src, o.meta),
      // only a message says whether its sender named relays
      msgAt: o.meta.via ? o.ts : (prev?.msgAt ?? null),
    });
    for (const l of meshcomLinks(o.src, o.meta))
      links.set(`${l.from}>${l.to}>${l.kind}`, { ...l, ts: o.ts, receiver: o.meta.receiver! });
  }
  const stmts: SqlStatement[] = [];
  for (const [call, n] of nodes) {
    const m = n.meta;
    const fresh = n.via === "direct" || n.via === "relayed";
    const rssi = fresh ? (m.rssi ?? null) : null;
    const snr = fresh ? (m.snr ?? null) : null;
    const sentVia = n.msgAt !== null && m.via?.length ? JSON.stringify(m.via) : null;
    stmts.push(
      env.DB.prepare(
        `INSERT INTO meshcom_nodes (callsign, last_heard, hw_id, firmware, batt, last_via, last_rssi, last_snr, quality, receiver, updated_at, sent_via, msg_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(callsign) DO UPDATE SET
           last_heard = excluded.last_heard,
           hw_id = COALESCE(excluded.hw_id, meshcom_nodes.hw_id),
           firmware = COALESCE(excluded.firmware, meshcom_nodes.firmware),
           batt = COALESCE(excluded.batt, meshcom_nodes.batt),
           last_via = excluded.last_via,
           last_rssi = CASE WHEN excluded.quality IS NULL THEN meshcom_nodes.last_rssi ELSE excluded.last_rssi END,
           last_snr = CASE WHEN excluded.quality IS NULL THEN meshcom_nodes.last_snr ELSE excluded.last_snr END,
           quality = COALESCE(excluded.quality, meshcom_nodes.quality),
           receiver = COALESCE(excluded.receiver, meshcom_nodes.receiver),
           sent_via = CASE WHEN excluded.msg_at IS NULL THEN meshcom_nodes.sent_via ELSE excluded.sent_via END,
           msg_at = COALESCE(excluded.msg_at, meshcom_nodes.msg_at),
           updated_at = excluded.updated_at
         WHERE excluded.updated_at >= meshcom_nodes.updated_at + ?
            OR (excluded.hw_id IS NOT NULL AND excluded.hw_id IS NOT meshcom_nodes.hw_id)
            OR (excluded.firmware IS NOT NULL AND excluded.firmware IS NOT meshcom_nodes.firmware)
            OR (excluded.batt IS NOT NULL AND (meshcom_nodes.batt IS NULL OR excluded.batt / 10 != meshcom_nodes.batt / 10))
            OR excluded.last_via IS NOT meshcom_nodes.last_via
            OR (excluded.receiver IS NOT NULL AND excluded.receiver IS NOT meshcom_nodes.receiver)
            OR (excluded.quality IS NOT NULL AND excluded.quality IS NOT meshcom_nodes.quality)
            OR (excluded.msg_at IS NOT NULL AND (meshcom_nodes.msg_at IS NULL OR excluded.sent_via IS NOT meshcom_nodes.sent_via))`,
      ).bind(
        call,
        n.ts,
        m.hwId ?? null,
        m.firmware ?? null,
        m.batt ?? null,
        n.via,
        rssi,
        snr,
        fresh ? meshcomQuality({ rssi, snr }) : null,
        m.receiver ?? null,
        n.ts,
        sentVia,
        n.msgAt,
        minS,
      ),
    );
  }
  // A link's average moves toward each new sample by 1/min(samples, N): the mean of the first N samples,
  // then a rolling average over roughly the last N.
  const avg = (col: string) =>
    `CASE WHEN excluded.${col} IS NULL THEN meshcom_links.${col}
          WHEN meshcom_links.${col} IS NULL THEN excluded.${col}
          ELSE meshcom_links.${col} + (excluded.${col} - meshcom_links.${col}) / MIN(meshcom_links.samples + 1, ${LINK_WINDOW})
     END`;
  for (const l of links.values())
    stmts.push(
      env.DB.prepare(
        `INSERT INTO meshcom_links (from_call, to_call, kind, last_seen, samples, rssi_avg, snr_avg, receiver, updated_at)
         VALUES (?,?,?,?,1,?,?,?,?)
         ON CONFLICT(from_call, to_call, kind) DO UPDATE SET
           last_seen = excluded.last_seen,
           samples = meshcom_links.samples + 1,
           rssi_avg = ${avg("rssi_avg")},
           snr_avg = ${avg("snr_avg")},
           receiver = excluded.receiver,
           updated_at = excluded.updated_at
         WHERE excluded.updated_at >= meshcom_links.updated_at + ?`,
      ).bind(l.from, l.to, l.kind, l.ts, l.rssi ?? null, l.snr ?? null, l.receiver, l.ts, minS),
    );
  return stmts;
}

/**
 * The Via setting of the operator's own MeshCom node(s), read from their own messages (`node` frames): on
 * with its relays when the latest names any, off when it names none, unknown until one has been seen. Only a
 * node's own echoes count — another station's via list says nothing about this node.
 */
export async function ownMeshcomVia(
  env: Env,
): Promise<{ node: string; state: "on" | "off" | "unknown"; relays: string[] }[]> {
  const rows = (
    await env.DB.prepare(
      "SELECT callsign, sent_via, msg_at FROM meshcom_nodes WHERE last_via = 'node' ORDER BY callsign",
    ).all<{ callsign: string; sent_via: string | null; msg_at: number | null }>()
  ).results;
  return rows.map((r) => {
    const relays = sentVia(r.sent_via);
    return { node: r.callsign, state: r.msg_at === null ? "unknown" : relays.length ? "on" : "off", relays };
  });
}

/** Nightly: drop nodes and links not heard within their windows. */
export async function pruneMeshcom(env: Env, now: number): Promise<void> {
  const nodeDays = intEnv(env.MESHCOM_NODE_TTL_DAYS, 7, 1);
  const linkHours = intEnv(env.MESHCOM_LINK_TTL_HOURS, 48, 1);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM meshcom_nodes WHERE last_heard < ?").bind(now - nodeDays * 86400),
    env.DB.prepare("DELETE FROM meshcom_links WHERE last_seen < ?").bind(now - linkHours * 3600),
  ]);
}

// ---- read API ------------------------------------------------------------------------------------------
// Who sees what: anyone sees each node's device, firmware, how and when it was heard, and plain-language
// signal quality and battery level; a signed-in member also sees the exact battery and signal figures.
// MeshCom data is on the air and largely public elsewhere, but exact device data of other hams is more
// than a map owes an anonymous visitor.

/** `minLon,minLat,maxLon,maxLat`, as /api/stations takes it; null when absent or malformed. */
function mapBbox(u: URL): [number, number, number, number] | null {
  const b = u.searchParams.get("bbox");
  if (!b) return null;
  const p = b.split(",").map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isFinite(n))) return null;
  return p as [number, number, number, number];
}
const clampInt = (v: string | null, dflt: number, lo: number, hi: number) =>
  Math.min(Math.max(Math.floor(Number(v ?? dflt)) || dflt, lo), hi);

interface NodeRow {
  callsign: string;
  lat: number;
  lon: number;
  symbol: string | null;
  last_heard: number;
  hw_id: number | null;
  firmware: string | null;
  batt: number | null;
  last_via: string;
  last_rssi: number | null;
  last_snr: number | null;
  quality: string | null;
  receiver: string | null;
  sent_via: string | null;
}

/** The relays stored for a node, or none: the column holds a JSON array the gateway itself wrote. */
function sentVia(v: string | null): string[] {
  if (!v) return [];
  try {
    const a: unknown = JSON.parse(v);
    return Array.isArray(a) ? a.filter((c): c is string => typeof c === "string") : [];
  } catch {
    return [];
  }
}

/** GET /api/meshcom/nodes — MeshCom nodes with a known position, as the operator's node(s) heard them; `call` picks one. */
export async function handleMeshcomNodes(req: Request, env: Env): Promise<Response> {
  const u = new URL(req.url);
  const maxAge = clampInt(u.searchParams.get("maxAge"), 86400, 60, 7 * 86400);
  const limit = clampInt(u.searchParams.get("limit"), 500, 1, 1000);
  const bb = mapBbox(u);
  const call = u.searchParams.get("call")?.trim().toUpperCase() || null;
  const exact = (await sessionIdentity(req, env)) !== null;
  const rows = (
    await env.DB.prepare(
      `SELECT n.callsign, s.lat, s.lon, s.symbol, n.last_heard, n.hw_id, n.firmware, n.batt, n.last_via,
              n.last_rssi, n.last_snr, n.quality, n.receiver, n.sent_via
         FROM meshcom_nodes n JOIN stations s ON s.callsign = n.callsign
        WHERE s.lat IS NOT NULL AND n.last_heard >= ?${bb ? " AND s.lat BETWEEN ? AND ? AND s.lon BETWEEN ? AND ?" : ""}${call ? " AND n.callsign = ?" : ""}
        ORDER BY n.last_heard DESC LIMIT ?`,
    )
      .bind(nowS() - maxAge, ...(bb ? [bb[1], bb[3], bb[0], bb[2]] : []), ...(call ? [call] : []), limit)
      .all<NodeRow>()
  ).results;
  return json({
    exact,
    nodes: rows.map((r) => ({
      callsign: r.callsign,
      lat: r.lat,
      lon: r.lon,
      symbol: r.symbol,
      lastHeard: r.last_heard,
      via: r.last_via,
      receiver: r.receiver,
      hwId: r.hw_id,
      firmware: r.firmware,
      quality: r.quality,
      battLevel: meshcomBattLevel(r.batt),
      ...(r.sent_via ? { sentVia: sentVia(r.sent_via) } : {}),
      ...(exact ? { batt: r.batt, rssi: r.last_rssi, snr: r.last_snr } : {}),
    })),
  });
}

interface LinkRow {
  from_call: string;
  to_call: string;
  kind: string;
  last_seen: number;
  samples: number;
  rssi_avg: number | null;
  snr_avg: number | null;
  receiver: string | null;
  from_lat: number;
  from_lon: number;
  to_lat: number;
  to_lon: number;
}

/** GET /api/meshcom/links — links whose both ends have a known position, as the operator's node(s) saw them. */
export async function handleMeshcomLinks(req: Request, env: Env): Promise<Response> {
  const u = new URL(req.url);
  const maxAge = clampInt(u.searchParams.get("maxAge"), 86400, 60, 48 * 3600);
  const limit = clampInt(u.searchParams.get("limit"), 500, 1, 1000);
  const bb = mapBbox(u);
  const exact = (await sessionIdentity(req, env)) !== null;
  const inBox = (t: string) => `(${t}.lat BETWEEN ? AND ? AND ${t}.lon BETWEEN ? AND ?)`;
  const boxBinds = bb ? [bb[1], bb[3], bb[0], bb[2]] : [];
  const rows = (
    await env.DB.prepare(
      `SELECT l.from_call, l.to_call, l.kind, l.last_seen, l.samples, l.rssi_avg, l.snr_avg, l.receiver,
              a.lat AS from_lat, a.lon AS from_lon, b.lat AS to_lat, b.lon AS to_lon
         FROM meshcom_links l
         JOIN stations a ON a.callsign = l.from_call
         JOIN stations b ON b.callsign = l.to_call
        WHERE a.lat IS NOT NULL AND b.lat IS NOT NULL AND l.last_seen >= ?${bb ? ` AND (${inBox("a")} OR ${inBox("b")})` : ""}
        ORDER BY l.last_seen DESC LIMIT ?`,
    )
      .bind(nowS() - maxAge, ...boxBinds, ...boxBinds, limit)
      .all<LinkRow>()
  ).results;
  return json({
    exact,
    links: rows.map((r) => ({
      from: r.from_call,
      to: r.to_call,
      kind: r.kind,
      lastSeen: r.last_seen,
      samples: r.samples,
      receiver: r.receiver,
      fromLat: r.from_lat,
      fromLon: r.from_lon,
      toLat: r.to_lat,
      toLon: r.to_lon,
      quality: meshcomQuality({ rssi: r.rssi_avg, snr: r.snr_avg }),
      ...(exact ? { rssi: r.rssi_avg, snr: r.snr_avg } : {}),
    })),
  });
}

// ---- group chat ----------------------------------------------------------------------------------------
// MeshCom group messages (to a group number, or `*` to all) as the operator's node(s) heard them, stored for
// the Messages panel's read-only group view. Kept apart from the callsign message log: a group message is
// addressed to no station. Pruned nightly with the message log (RETENTION messagesDays).

/** The longest group text stored; MeshCom's own limit is shorter. */
const GROUP_TEXT_MAX = 200;
/** A group number, or `*` for all — as packages/aprs `meshcomGroupOf` reads it. */
const GROUP = /^(\*|[1-9]\d{0,4})$/;

/** A group message one ingest packet carried. */
export interface MeshcomGroupHearing {
  from: string;
  group: string;
  text: string;
  ts: number;
  meta: MeshcomMeta | null;
}

/** How strongly a hearing places the message near the operator's node: direct LoRa, relayed LoRa, anything else. */
const heardRank = (col: string) => `(CASE ${col} WHEN 'direct' THEN 3 WHEN 'relayed' THEN 2 ELSE 1 END)`;

/**
 * The statement that stores one group message. Every copy of a MeshCom frame carries the sender's `msg_id`, so
 * the sender and that id name the message: a second node hearing it, or the MeshCom server echoing it, adds no
 * row. A frame without an id is keyed on its sender, group, text and ten-minute bucket instead. A later copy
 * heard more directly replaces how it was heard and by which node.
 */
export function meshcomGroupStatement(env: Env, h: MeshcomGroupHearing): SqlStatement {
  const text = h.text.slice(0, GROUP_TEXT_MAX);
  const msgId = h.meta?.msgId ?? null;
  const key = msgId ? `id:${h.from}:${msgId}` : `tx:${h.from}:${h.group}:${Math.floor(h.ts / 600)}:${text}`;
  const heard = h.meta ? meshcomVia(h.from, h.meta) : null;
  return env.DB.prepare(
    `INSERT INTO meshcom_group_messages (ts, from_call, grp, body, msg_id, receiver, heard, dedup_key)
     VALUES (?,?,?,?,?,?,?,?)
     ON CONFLICT(dedup_key) DO UPDATE SET heard = excluded.heard, receiver = excluded.receiver
     WHERE ${heardRank("excluded.heard")} > ${heardRank("meshcom_group_messages.heard")}`,
  ).bind(h.ts, h.from, h.group, text, msgId, h.meta?.receiver ?? null, heard, key);
}

/** GET /api/meshcom/groups — the groups heard within the message retention, most recently active first. */
export async function handleMeshcomGroups(_req: Request, env: Env): Promise<Response> {
  const rows = (
    await env.DB.prepare(
      `SELECT grp, COUNT(*) AS messages, MAX(ts) AS lastHeard FROM meshcom_group_messages
        GROUP BY grp ORDER BY lastHeard DESC LIMIT 200`,
    ).all<{ grp: string; messages: number; lastHeard: number }>()
  ).results;
  return json({ groups: rows.map((r) => ({ group: r.grp, messages: r.messages, lastHeard: r.lastHeard })) });
}

/** GET /api/meshcom/groups/:group/messages — one group's messages, newest first, keyset-paged. */
export async function handleMeshcomGroupMessages(req: Request, env: Env, group: string): Promise<Response> {
  if (!GROUP.test(group)) return json({ error: "group must be a number from 1 to 99999, or *" }, { status: 400 });
  const pg = parsePage(new URL(req.url), 50, 200);
  const ks = keyset(pg.cursor, "ts", "id");
  const rows = (
    await env.DB.prepare(
      `SELECT id, ts, from_call AS fromCall, body, receiver, heard FROM meshcom_group_messages
        WHERE grp = ?${ks.sql} ORDER BY ts DESC, id DESC LIMIT ?`,
    )
      .bind(group, ...ks.binds, pg.limit + 1)
      .all<{ id: number; ts: number }>()
  ).results;
  const page = paginate(rows, pg.limit, (r) => ({ primary: r.ts, id: r.id }));
  return json({ group, messages: page.items, nextCursor: page.nextCursor, hasMore: page.hasMore });
}
