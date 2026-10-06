// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * fedtransit.ts — an instance passes on what it mirrored. A club hub hears from every spoke; through the
 * transit feed each spoke hears from the others as well, and from anyone the hub follows.
 *
 *   GET /federation/sync/transit?since=<seq>&limit=&bbox=&for=<instance>   the frames, as a CBOR sync page
 *   GET /federation/transit/keys                                           the keys of their origins (JSON)
 *
 * Every cache, find and tombstone admitted from another instance keeps the frame its origin signed, byte for
 * byte (`fed_transit`). The transit feed serves those frames again, never re-signed: a receiver verifies each
 * against its ORIGIN's key and applies its own trust in that origin, so a hub lends a record nothing, neither
 * trust nor a voice in the corroboration quorum. What a hub passes on is a site setting (FED_RESERVE):
 * `trusted` (the default) the records of origins it trusts, `all` those of every origin it has not blocked,
 * `off` none.
 *
 * Keys. A receiver verifies an origin it has never peered with under the key the hub hands on
 * (`/federation/transit/keys`: the origin's pinned key, its accept set and its rotation records). The first
 * hub to name an origin's key pins it in a `transit:<instance>` peer row, `unvetted` and never pulled, so
 * the sysop sees the origin, compares its fingerprint and trusts or blocks it like any peer; afterwards the
 * key moves only along a verified rotation chain. A registry binding wins over any hub's word. An origin
 * the receiver later follows directly replaces the hub's pin, and the records vouched for only by a key the
 * origin does not hold are dropped with it.
 *
 * Loops. A record crosses at most MAX_TRANSIT_HOPS instances; the page carries each frame's hop count
 * beside it. Apply is idempotent by global id and version, so a record coming back around a ring of
 * mutually peered hubs changes nothing and is not stored again. A record never goes back to its origin
 * nor to the instance it came from (`for`), and the server's own records travel on its own feeds only.
 *
 * Scope. A local-only cache and imported data never leave their origin: the origin's feeds leave them out,
 * every receiver refuses them (fedapply.ts), and the transit feed serves neither.
 */
import type { Env } from "./env.js";
import { json } from "./app.js";
import { nowS } from "./util/time.js";
import { setting } from "./siteconfig.js";
import { encodeFedSyncPage, type FedFrame } from "@aprscaching/shared";
import {
  instanceOf,
  isInstanceId,
  loadKey,
  parseAcceptKeys,
  registryKeyAllowed,
  resolvePeerKeys,
  usableKeys,
  type FedPublicKey,
  type RegistryEntry,
  type RotationRecord,
} from "./federation.js";
import { bboxWhere, parseBbox } from "./fedregion.js";

/** The descriptor capability of an instance serving the transit feed. */
export const TRANSIT_CAPABILITY = "transit";
/** The record kinds the transit feed carries. */
export const TRANSIT_KINDS: ReadonlySet<string> = new Set(["cache", "find", "tombstone"]);
/** The most instances a record crosses: one passed on at this count is kept, never passed on again. */
export const MAX_TRANSIT_HOPS = 4;
/** Origins learned through hubs: the peer table never grows past this many `transit:` rows. */
const MAX_TRANSIT_PEERS = 500;
/** Key bundles one descriptor hands on. */
const MAX_TRANSIT_KEYS = 500;
/** Rotation records kept per origin. */
const MAX_ROTATIONS = 32;

type ReservePolicy = "trusted" | "all" | "off";

/** Which mirrored records this instance passes on (FED_RESERVE). */
export function reservePolicy(env: Env): ReservePolicy {
  const v = setting(env, "FED_RESERVE");
  return v === "all" || v === "off" ? v : "trusted";
}

/** The `fed_transit` rows the policy lets out, as SQL over the alias `t`. */
function policySql(policy: ReservePolicy): string {
  const notBlocked = "NOT EXISTS (SELECT 1 FROM fed_peers b WHERE b.instance = t.origin AND b.trust = 'blocked')";
  if (policy === "all") return notBlocked;
  return `${notBlocked} AND EXISTS (SELECT 1 FROM fed_peers p WHERE p.instance = t.origin AND p.trust = 'trusted')`;
}

/**
 * Keep an admitted frame for the transit feed. A newer version replaces the frame and moves to the end of
 * the feed. `via` is the instance that delivered it, `hops` how many instances it has crossed to reach here.
 */
export async function keepForTransit(
  env: Env,
  fb: Uint8Array,
  f: FedFrame,
  data: Record<string, unknown>,
  via: string,
  hops: number,
): Promise<void> {
  const kind = f.record.kind;
  if (!TRANSIT_KINDS.has(kind)) return;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  await env.DB.prepare(
    `INSERT INTO fed_transit (gid, origin, kind, v, frame, signer_key, via, hops, target, scope, lat, lon, seq, received_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM fed_transit), ?)
     ON CONFLICT(gid) DO UPDATE SET
       v = excluded.v, frame = excluded.frame, signer_key = excluded.signer_key, via = excluded.via,
       hops = excluded.hops, target = excluded.target, scope = excluded.scope, lat = excluded.lat,
       lon = excluded.lon, seq = excluded.seq, received_at = excluded.received_at
     WHERE excluded.v > fed_transit.v`,
  )
    .bind(
      f.record.gid,
      f.record.origin,
      kind,
      f.record.v,
      fb,
      f.signerKey,
      via,
      hops,
      kind === "tombstone" && typeof data.targetId === "string" ? data.targetId : null,
      kind === "cache" && typeof data.fedScope === "string" ? data.fedScope : null,
      kind === "cache" ? num(data.lat) : null,
      kind === "cache" ? num(data.lon) : null,
      nowS(),
    )
    .run();
}

/**
 * Move an origin's kept records to the end of the transit feed, so followers whose cursor passed them while
 * the policy held them back receive them now (the origin was just trusted or unblocked here).
 */
export async function requeueOrigin(env: Env, instance: string | null | undefined): Promise<void> {
  if (!instance) return;
  // every new seq lies above the current maximum, so no two rows ever share one mid-update
  await env.DB.prepare(
    "UPDATE fed_transit SET seq = seq + (SELECT COALESCE(MAX(seq), 0) FROM fed_transit) WHERE origin = ?",
  )
    .bind(instance)
    .run();
}

interface TransitRow {
  seq: number;
  frame: Uint8Array | ArrayBuffer;
  hops: number;
}

/**
 * Serve one transit page: the kept frames after `since`, as their origins signed them, each with its hop
 * count. 404 while FED_RESERVE is `off` or the instance is unsigned, as for any feed a consumer may skip.
 */
export async function handleTransitSync(req: Request, env: Env): Promise<Response> {
  const policy = reservePolicy(env);
  if (policy === "off") return json({ error: "this instance passes on no records" }, { status: 404 });
  if (!(await loadKey(env))) return json({ error: "instance is unsigned" }, { status: 404 });
  const u = new URL(req.url);
  const since = Math.max(0, Number(u.searchParams.get("since") ?? 0) || 0);
  const limit = Math.min(Math.max(Number(u.searchParams.get("limit") ?? 200) || 200, 1), 1000);
  const bboxRaw = u.searchParams.get("bbox");
  const bbox = bboxRaw != null ? parseBbox(bboxRaw) : null;
  if (bboxRaw != null && !bbox) return json({ error: "bbox must be S,W,N,E in decimal degrees" }, { status: 400 });
  // the asking instance, so nothing goes back to where it came from; a request without it is filtered by
  // the receiver, which refuses its own records anyway
  const asker = (u.searchParams.get("for") ?? "").toLowerCase();
  const region = bbox ? bboxWhere(bbox) : null;
  const rows = (
    await env.DB.prepare(
      `SELECT t.seq, t.frame, t.hops FROM fed_transit t
        WHERE t.seq > ? AND t.hops < ? AND t.origin != ? AND t.via != ?
          AND COALESCE(t.scope, 'public') != 'local-only'
          AND ${policySql(policy)}
          AND (t.kind = 'tombstone'
               OR (t.kind = 'cache' ${region ? `AND ${region.sql}` : ""}
                   AND EXISTS (SELECT 1 FROM remote_caches rc WHERE rc.global_id = t.gid))
               OR (t.kind = 'find' AND EXISTS (SELECT 1 FROM remote_finds rf WHERE rf.global_id = t.gid)))
        ORDER BY t.seq LIMIT ?`,
    )
      .bind(since, MAX_TRANSIT_HOPS, asker, asker, ...(region?.params ?? []), limit)
      .all<TransitRow>()
  ).results;
  const frames = rows.map((r) => (r.frame instanceof Uint8Array ? r.frame : new Uint8Array(r.frame)));
  const next = rows.length ? rows[rows.length - 1]!.seq : since;
  return new Response(
    encodeFedSyncPage(
      instanceOf(req, env),
      next,
      rows.length < limit,
      frames,
      undefined,
      rows.map((r) => r.hops),
    ) as BodyInit,
    { headers: { "content-type": "application/cbor" } },
  );
}

/** One origin's key as a hub hands it on: its pin, the keys it still accepts, and its rotation records. */
interface TransitKeyBundle {
  instance: string;
  publicKey: string;
  publicKeys: FedPublicKey[];
  rotations: RotationRecord[];
}

const parseRotations = (s: string | null | undefined): RotationRecord[] => {
  try {
    const v = s ? (JSON.parse(s) as unknown) : [];
    return Array.isArray(v) ? (v as RotationRecord[]).slice(-MAX_ROTATIONS) : [];
  } catch {
    return [];
  }
};

/** GET /federation/transit/keys — the keys of every origin the transit feed passes on. 404 while it is off. */
export async function handleTransitKeys(req: Request, env: Env): Promise<Response> {
  const policy = reservePolicy(env);
  if (policy === "off") return json({ error: "this instance passes on no records" }, { status: 404 });
  const rows = (
    await env.DB.prepare(
      `SELECT fp.instance, fp.public_key, fp.accept_keys, fp.rotations FROM fed_peers fp
        WHERE fp.trust != 'blocked' AND fp.public_key IS NOT NULL
          AND fp.instance IN (SELECT DISTINCT t.origin FROM fed_transit t WHERE t.hops < ? AND ${policySql(policy)})
        ORDER BY fp.instance LIMIT ?`,
    )
      .bind(MAX_TRANSIT_HOPS, MAX_TRANSIT_KEYS)
      .all<{ instance: string; public_key: string; accept_keys: string | null; rotations: string | null }>()
  ).results;
  const keys: TransitKeyBundle[] = rows.map((r) => ({
    instance: r.instance,
    publicKey: r.public_key,
    publicKeys: parseAcceptKeys(r.accept_keys).map((k) => ({ x: k.x, ...(k.until != null && { until: k.until }) })),
    rotations: parseRotations(r.rotations),
  }));
  return json({ instance: instanceOf(req, env), keys });
}

/** Keep a peer's rotation records (from its descriptor or a submission), so a hub can hand them on. */
export function rotationsJson(rotations: unknown): string | null {
  return Array.isArray(rotations) && rotations.length ? JSON.stringify(rotations.slice(-MAX_ROTATIONS)) : null;
}

/**
 * Pin the keys a hub hands on for origins this instance does not know yet, and follow the rotations of those
 * it learned that way. An origin known any other way (pulled, added, submitted, 44Net, the registry's peer
 * list) keeps its own binding, and a blocked one stays blocked: no hub can move either.
 */
export async function learnTransitKeys(
  env: Env,
  hub: string,
  bundles: unknown,
  registry: Map<string, RegistryEntry>,
): Promise<void> {
  if (!Array.isArray(bundles)) return;
  const us = env.INSTANCE ?? null;
  for (const raw of bundles.slice(0, MAX_TRANSIT_KEYS)) {
    const b = raw as Partial<TransitKeyBundle> | null;
    if (!b || !isInstanceId(b.instance) || b.instance === us || b.instance === hub) continue;
    if (typeof b.publicKey !== "string" || !b.publicKey) continue;
    const row = await env.DB.prepare(
      `SELECT url, added_via, public_key, accept_keys, trust FROM fed_peers WHERE instance = ?
        ORDER BY trust = 'blocked' DESC, url LIMIT 1`,
    )
      .bind(b.instance)
      .first<{
        url: string;
        added_via: string | null;
        public_key: string | null;
        accept_keys: string | null;
        trust: string;
      }>();
    if (row && (row.added_via !== "transit" || row.trust === "blocked")) continue;
    if (!registryKeyAllowed(registry.get(b.instance), b.publicKey)) continue;
    const rotations = Array.isArray(b.rotations) ? b.rotations.slice(-MAX_ROTATIONS) : [];
    const keys = await resolvePeerKeys({
      pinned: row?.public_key ?? null,
      current: b.publicKey,
      published: Array.isArray(b.publicKeys) ? b.publicKeys : [],
      rotations,
      prior: parseAcceptKeys(row?.accept_keys),
      nowS: nowS(),
      graceDays: env.FED_ROTATION_GRACE_DAYS ? Number(env.FED_ROTATION_GRACE_DAYS) : undefined,
    });
    if (!keys.ok || !keys.pin) continue; // a key that moved without a proof keeps the first one
    if (row) {
      await env.DB.prepare("UPDATE fed_peers SET public_key = ?, accept_keys = ?, rotations = ? WHERE url = ?")
        .bind(keys.pin, JSON.stringify(keys.accept), rotationsJson(rotations), row.url)
        .run();
      continue;
    }
    const n =
      (
        await env.DB.prepare("SELECT COUNT(*) AS n FROM fed_peers WHERE added_via = 'transit'").first<{
          n: number;
        }>()
      )?.n ?? 0;
    if (n >= MAX_TRANSIT_PEERS) continue;
    await env.DB.prepare(
      `INSERT OR IGNORE INTO fed_peers (url, instance, public_key, accept_keys, rotations, trust, added_via, enabled)
       VALUES (?, ?, ?, ?, ?, 'unvetted', 'transit', 0)`,
    )
      .bind(`transit:${b.instance}`, b.instance, keys.pin, JSON.stringify(keys.accept), rotationsJson(rotations))
      .run();
  }
}

/**
 * Drop the records of `instance` that reached here through a hub under a key outside `keep`: they were
 * vouched for only by the key a hub handed on. Followers' transit cursors start over, so whatever the
 * origin's own key does cover arrives again. Returns how many records went.
 */
async function dropHubVouched(env: Env, instance: string, keep: ReadonlySet<string>): Promise<number> {
  const rows = (
    await env.DB.prepare("SELECT gid, kind, target, signer_key FROM fed_transit WHERE origin = ? AND hops > 1")
      .bind(instance)
      .all<{ gid: string; kind: string; target: string | null; signer_key: string }>()
  ).results.filter((r) => !keep.has(r.signer_key));
  for (const r of rows)
    await env.DB.batch([
      env.DB.prepare("DELETE FROM remote_caches WHERE global_id = ? AND origin = ?").bind(r.gid, instance),
      env.DB.prepare("DELETE FROM remote_finds WHERE global_id = ? AND origin = ?").bind(r.gid, instance),
      ...(r.kind === "tombstone" && r.target
        ? [env.DB.prepare("DELETE FROM remote_tombstones WHERE target_id = ? AND origin = ?").bind(r.target, instance)]
        : []),
      env.DB.prepare("DELETE FROM fed_versions WHERE gid = ?").bind(r.gid),
      env.DB.prepare("DELETE FROM fed_transit WHERE gid = ?").bind(r.gid),
    ]);
  if (rows.length) await env.DB.prepare("UPDATE fed_peers SET transit_cursor = 0").run();
  return rows.length;
}

/**
 * A direct binding for `instance` (a pull, an add by address) replaces the key a hub handed on: the
 * `transit:` row goes, and so does every record that only the hub's key vouched for. Call it once the
 * direct keys are verified, before the direct row takes the instance id.
 */
export async function supersedeTransitPeer(env: Env, instance: string, directKeys: readonly string[]): Promise<void> {
  const row = await env.DB.prepare(
    "SELECT url FROM fed_peers WHERE instance = ? AND added_via = 'transit' AND trust != 'blocked'",
  )
    .bind(instance)
    .first<{ url: string }>();
  if (!row) return;
  await dropHubVouched(env, instance, new Set(directKeys));
  await env.DB.prepare("DELETE FROM fed_peers WHERE url = ?").bind(row.url).run();
}

/** A removed `transit:` row takes the records its key vouched for with it. */
export async function forgetTransitPeer(env: Env, instance: string): Promise<void> {
  await dropHubVouched(env, instance, new Set());
}

/** The usable keys of an accept set plus its pin: what a direct binding holds. */
export function heldKeys(pin: string | null, accept: ReturnType<typeof parseAcceptKeys>): string[] {
  return [...new Set([...(pin ? [pin] : []), ...usableKeys(accept, nowS())])];
}
