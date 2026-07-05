// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * fedsync.ts — the CBOR federation sync surface. `GET /federation/sync/<type>?since=&limit=` serves
 * the same records as the JSON feeds, but as fedwire frames: deterministic CBOR payloads signed
 * under the domain-separated instance key (fedcbor.ts). The frame bytes are the canonical signed
 * form — a consumer verifies them verbatim and can forward them over any carrier unchanged.
 *
 * The page envelope is CBOR too (unsigned — each record carries its own signature, matching the
 * JSON feed model): {1 instance, 2 nextCursor, 3 complete, 4 [frame bytes…]}.
 *
 * Bodies are the JSON feed `data` objects with every fractional field scaled to an integer twin
 * (the deterministic codec refuses floats): lat/lon ↔ latE7/lonE7 (1e-7°), difficulty/terrain ↔
 * ×10, distanceM ↔ centimetres. The consumer maps them back before apply, so both sync encodings
 * feed the identical mirror/tombstone logic.
 */
import type { Env } from "./env.js";
import { json } from "./app.js";
import {
  cborEncode,
  cborDecode,
  type CborMap,
  type CborValue,
  encodeFedPayload,
  type FedRecord,
  type FedRecordKind,
} from "@aprsweb/shared";
import { signRaw } from "./federation.js";
import { fedSigningBytes, encodeFedFrame } from "@aprsweb/shared";
import { CACHE_FEED, FIND_FEED, KEY_FEED, instanceOf, type FeedServeDef } from "./federation.js";
import { TOMBSTONE_FEED } from "./tombstones.js";
import { BULLETIN_FEED } from "./bbs.js";
import { ACCOUNT_MOVE_FEED } from "./account.js";

export const SYNC_CBOR_CAPABILITY = "sync-cbor";

/** Feed type → envelope record kind (the sync type strings are the shared vocabulary). */
const KIND_FOR_TYPE: Record<string, FedRecordKind> = {
  cache: "cache",
  find: "find",
  key: "key",
  tombstone: "tombstone",
  "account-move": "accountMove",
  bulletin: "bulletin",
};

const FEED_FOR_TYPE: Record<string, FeedServeDef> = {
  cache: CACHE_FEED,
  find: FIND_FEED,
  key: KEY_FEED,
  tombstone: TOMBSTONE_FEED,
  "account-move": ACCOUNT_MOVE_FEED,
  bulletin: BULLETIN_FEED,
};

// ---- fractional fields ↔ integer wire twins (the deterministic codec refuses floats) ----

const SCALED_FIELDS = [
  { json: "lat", wire: "latE7", scale: 1e7 },
  { json: "lon", wire: "lonE7", scale: 1e7 },
  { json: "difficulty", wire: "difficultyX10", scale: 10 },
  { json: "terrain", wire: "terrainX10", scale: 10 },
  { json: "distanceM", wire: "distanceCm", scale: 100 },
] as const;

/** JSON record data → wire body: fractional fields become rounded scaled integers. */
export function bodyToWire(data: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...data };
  for (const f of SCALED_FIELDS) {
    if (typeof out[f.json] === "number") {
      out[f.wire] = Math.round((out[f.json] as number) * f.scale);
      delete out[f.json];
    }
  }
  return out;
}

/** Wire body → JSON record data: scaled integers back to their fractional fields. */
export function bodyFromWire(body: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...body };
  for (const f of SCALED_FIELDS) {
    if (typeof out[f.wire] === "number") {
      out[f.json] = (out[f.wire] as number) / f.scale;
      delete out[f.wire];
    }
  }
  return out;
}

// ---- the CBOR page envelope ----

const P_INSTANCE = 1,
  P_NEXT = 2,
  P_COMPLETE = 3,
  P_FRAMES = 4;

export function encodeFedSyncPage(instance: string, nextCursor: number, complete: boolean, frames: Uint8Array[]): Uint8Array {
  const m: CborMap = new Map<number, CborValue>([
    [P_INSTANCE, instance],
    [P_NEXT, nextCursor],
    [P_COMPLETE, complete],
    [P_FRAMES, frames as CborValue[]],
  ]);
  return cborEncode(m);
}

export interface FedSyncPage {
  instance: string;
  nextCursor: number;
  complete: boolean;
  frames: Uint8Array[];
}

export function decodeFedSyncPage(bytes: Uint8Array): FedSyncPage {
  const m = cborDecode(bytes);
  if (!(m instanceof Map)) throw new Error("fedsync: page is not a map");
  const instance = m.get(P_INSTANCE);
  const nextCursor = m.get(P_NEXT);
  const complete = m.get(P_COMPLETE);
  const frames = m.get(P_FRAMES);
  if (typeof instance !== "string" || typeof nextCursor !== "number" || typeof complete !== "boolean")
    throw new Error("fedsync: malformed page envelope");
  if (!Array.isArray(frames) || frames.some((f) => !(f instanceof Uint8Array)))
    throw new Error("fedsync: frames must be byte strings");
  return { instance, nextCursor, complete, frames: frames as Uint8Array[] };
}

/**
 * Serve one CBOR sync page. Unknown feed type → 404 (the same forward-compat contract as the JSON
 * feeds); an unsigned instance → 404 too, so a consumer falls back to the JSON surface — CBOR sync
 * exists only where every frame can carry a signature.
 */
export async function handleFedSync(req: Request, env: Env, feedType: string): Promise<Response> {
  const def = FEED_FOR_TYPE[feedType];
  const kind = KIND_FOR_TYPE[feedType];
  if (!def || !kind) return json({ error: "unknown feed" }, { status: 404 });
  const u = new URL(req.url);
  const since = Math.max(0, Number(u.searchParams.get("since") ?? 0) || 0);
  const limit = Math.min(Math.max(Number(u.searchParams.get("limit") ?? 200) || 200, 1), 1000);
  const instance = instanceOf(req, env);
  const at = Math.floor(Date.now() / 1000);

  const rows = await def.selectRows(env, since, limit);
  let nextCursor = since;
  const frames: Uint8Array[] = [];
  for (const r of rows) {
    const { id, cursor, data } = def.recordOf(r, instance);
    const record: FedRecord = {
      kind,
      gid: id,
      origin: instance,
      v: cursor,
      at,
      signer: instance,
      body: bodyToWire(data as Record<string, unknown>),
    };
    const payload = encodeFedPayload(record);
    const signed = await signRaw(env, fedSigningBytes(payload));
    if (!signed) return json({ error: "instance is unsigned" }, { status: 404 });
    frames.push(encodeFedFrame(payload, signed.publicX, signed.sig));
    if (cursor > nextCursor) nextCursor = cursor;
  }
  return new Response(encodeFedSyncPage(instance, nextCursor, frames.length < limit, frames) as BodyInit, {
    headers: { "content-type": "application/cbor" },
  });
}
