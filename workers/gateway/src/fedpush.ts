// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * fedpush.ts — push-to-hub: NAT/firewall peers contribute without inbound reachability. A spoke
 * pushes sync pages of its own signed frames to a hub (pushToHub); the hub binds the submitter's
 * identity and admits the frames through the same path as a pull (handleFederationSubmit).
 */
import type { Env } from "./env.js";
import { json } from "./app.js";
import { secretOk } from "./auth.js";
import { nowS } from "./util/time.js";
import { fedFetch, readCappedBody, trimTrailingSlashes } from "./fetchguard.js";
import {
  isInstanceId,
  loadRegistry,
  parseAcceptKeys,
  resolvePeerKeys,
  usableKeys,
  CACHE_FEED,
  FIND_FEED,
  KEY_FEED,
  type FeedServeDef,
  type RotationRecord,
  type RegistryEntry,
} from "./federation.js";
import { TOMBSTONE_FEED } from "./tombstones.js";
import { decodeFedSyncPage, encodeFedSyncPage, buildFedFrames } from "./fedsync.js";
import { decodeFedFrame } from "@aprscaching/shared";
import { type TrustLevel, ours } from "./fedpeers.js";
import { applyFrames } from "./fedapply.js";
import { MAX_PAGES } from "./fedpull.js";

/** The feeds a spoke pushes — tombstones first, matching the sync ordering so a delete suppresses re-mirror. */
const PUSH_FEEDS: FeedServeDef[] = [TOMBSTONE_FEED, CACHE_FEED, FIND_FEED, KEY_FEED];
const PUSH_CURSORS = new Map<string, { cursor: number; id?: number }>(); // "hub|type" -> last pushed position (in-memory; re-push on restart is idempotent)
/** Largest submission body the hub reads: a full page of frames fits well inside it. */
const MAX_SUBMIT_BYTES = 4 * 1024 * 1024;

/**
 * HUB endpoint: accept a spoke's signed records and mirror them as if we had pulled them
 * (push-mode mirroring — same remote_* tables, same display-only semantics). Secret-gated; optionally
 * restricted to an instance allowlist. Each record is verified against the supplied key and MUST name
 * the submitter as its signer, so a spoke can only contribute records as ITSELF — never impersonate
 * another instance. A spoke that rotated its key sends its rotation records in `x-fed-rotations`.
 */
export async function handleFederationSubmit(req: Request, env: Env): Promise<Response> {
  const secret = env.FED_SUBMIT_SECRET;
  if (!secret) return json({ ok: false, error: "submit disabled" }, { status: 403 });
  if (!secretOk(req.headers.get("x-fed-secret"), secret))
    return json({ ok: false, error: "unauthorized" }, { status: 401 });

  // A submission is a sync page of fedwire frames — the same signed bytes every other carrier
  // moves. The page's instance declares the submitter; every frame must be signed by ONE key (a
  // submission is one spoke), verified over the frame bytes verbatim.
  if (!(req.headers.get("content-type") ?? "").includes("application/cbor"))
    return json({ ok: false, error: "submit is application/cbor (a fedwire sync page)" }, { status: 415 });
  const body = await readCappedBody(req, MAX_SUBMIT_BYTES);
  if (!body) return json({ ok: false, error: "submission too large" }, { status: 413 });
  let page: ReturnType<typeof decodeFedSyncPage>;
  try {
    page = decodeFedSyncPage(body);
  } catch {
    return json({ ok: false, error: "not a CBOR sync page" }, { status: 400 });
  }
  if (!isInstanceId(page.instance))
    return json({ ok: false, error: "submitter instance id is not a hostname" }, { status: 400 });
  let rotations: RotationRecord[] = [];
  try {
    const h = req.headers.get("x-fed-rotations");
    if (h && h.length <= 16_384) rotations = (JSON.parse(h) as RotationRecord[]).slice(0, 32);
  } catch {
    return json({ ok: false, error: "x-fed-rotations is not a JSON array of rotation records" }, { status: 400 });
  }
  // A submission is one spoke, so every frame must verify under ONE key: the first frame's names it,
  // and the identity checks below decide whether the hub accepts that key for the instance.
  let submitKey: string | null = null;
  for (const fb of page.frames) {
    try {
      submitKey = decodeFedFrame(fb).signerKey;
      break;
    } catch {
      continue;
    }
  }
  if (!submitKey) return json({ ok: false, error: "no verifiable frames" }, { status: 400 });
  return submitFrames(env, page.instance, submitKey, page.frames, rotations);
}

/**
 * The submit core: allowlist, the registry + TOFU key binding and spoke registration, then every frame
 * through the shared admission path (fedapply.ts) under the bound key — the same signature, origin,
 * namespace, tombstone and version checks as a pulled frame. A submission carries mirror records only.
 */
async function submitFrames(
  env: Env,
  instance: string,
  publicKey: string,
  frames: Uint8Array[],
  rotations: RotationRecord[] = [],
): Promise<Response> {
  if (instance === ours(env)) return json({ ok: false, error: "cannot submit as this instance" }, { status: 400 });
  const allow = (env.FED_SUBMIT_INSTANCES ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (allow.length && !allow.includes(instance))
    return json({ ok: false, error: "instance not allowed" }, { status: 403 });

  // A secret-holder must not be able to impersonate a KNOWN instance. The signed registry binding
  // wins; otherwise the submitted key must be one the hub already verified for this instance, under
  // ANY row — a pulled peer, a 44net or registry entry, or an earlier submission. A shared secret is
  // not an identity, so a blocked instance stays out and a new spoke enters unvetted until the
  // operator promotes it.
  let registry: Map<string, RegistryEntry>;
  try {
    registry = await loadRegistry(env);
  } catch {
    return json({ ok: false, error: "federation registry is misconfigured on this hub" }, { status: 503 });
  }
  const regEntry = registry.get(instance);
  if (regEntry?.key && regEntry.key !== publicKey)
    return json({ ok: false, error: "submitted key does not match the registry for this instance" }, { status: 403 });
  const known = (
    await env.DB.prepare("SELECT url, public_key, accept_keys, trust FROM fed_peers WHERE instance = ?")
      .bind(instance)
      .all<{ url: string; public_key: string | null; accept_keys: string | null; trust: TrustLevel }>()
  ).results;
  if (known.some((r) => r.trust === "blocked"))
    return json({ ok: false, error: "instance is blocked on this hub" }, { status: 403 });
  for (const r of known) {
    const accept = parseAcceptKeys(r.accept_keys);
    const keys = accept.length ? usableKeys(accept, nowS()) : r.public_key ? [r.public_key] : [];
    if (!keys.length || keys.includes(publicKey)) continue;
    // A spoke that rotated proves it the same way a pulled peer does: rotation records (sent in
    // x-fed-rotations) leading from its pinned key to the new one. Only its own submit row moves.
    if (r.url === `submit:${instance}` && r.public_key) {
      const moved = await resolvePeerKeys({
        pinned: r.public_key,
        current: publicKey,
        published: [{ x: publicKey }, ...accept.filter((k) => k.x !== publicKey)],
        rotations,
        prior: accept,
        nowS: nowS(),
        graceDays: env.FED_ROTATION_GRACE_DAYS ? Number(env.FED_ROTATION_GRACE_DAYS) : undefined,
      });
      if (moved.ok) {
        await env.DB.prepare("UPDATE fed_peers SET public_key = ?, accept_keys = ? WHERE url = ?")
          .bind(moved.pin, JSON.stringify(moved.accept), r.url)
          .run();
        continue;
      }
    }
    return json({ ok: false, error: "submitted key does not match the key known for this instance" }, { status: 403 });
  }

  // Register a new spoke as a never-pulled peer so its mirrored records carry a uniform trust
  // binding: enabled=0 keeps it out of the pull set, and the synthetic `submit:<instance>` url
  // marks how it arrived.
  if (!known.length)
    await env.DB.prepare(
      "INSERT OR IGNORE INTO fed_peers (url, instance, public_key, accept_keys, trust, added_via, enabled) VALUES (?, ?, ?, ?, 'unvetted', 'submitted', 0)",
    )
      .bind(`submit:${instance}`, instance, publicKey, JSON.stringify([{ x: publicKey }]))
      .run();

  const { applied, rejected } = await applyFrames(env, frames, {
    origin: instance,
    keysFor: async () => [publicKey],
    mirrorOnly: true,
  });
  return json({ ok: true, applied, rejected });
}

/**
 * SPOKE side: push our signed records to a configured hub (push-mode mirroring) when we can't be
 * pulled — a sync page of fedwire frames, the same signed bytes as every other carrier. Incremental
 * via in-memory cursors; idempotent (the hub upserts by global id), so a restart that re-pushes
 * from 0 is harmless. No-op unless FED_HUB_URL + FED_SUBMIT_SECRET + a signing key are present.
 */
export async function pushToHub(
  env: Env,
  fetchFn: (url: string, init?: RequestInit) => Promise<Response> = (u, i) => fedFetch(env, u, i),
): Promise<{ pushed: number } | null> {
  const hub = env.FED_HUB_URL ? trimTrailingSlashes(env.FED_HUB_URL) : undefined;
  const secret = env.FED_SUBMIT_SECRET;
  if (!hub || !secret || !env.INSTANCE) return null;
  let pushed = 0;
  for (const def of PUSH_FEEDS) {
    const ckey = `${hub}|${def.type}`;
    let { cursor, id } = PUSH_CURSORS.get(ckey) ?? { cursor: 0 };
    for (let page = 0; page < MAX_PAGES; page++) {
      const built = await buildFedFrames(env, env.INSTANCE, def.type, cursor, 500, id);
      if (!built) return null; // no signing key — nothing verifiable to push
      if (!built.frames.length) break;
      const complete = built.frames.length < 500;
      const res = await fetchFn(`${hub}/federation/submit`, {
        method: "POST",
        headers: {
          "content-type": "application/cbor",
          "x-fed-secret": secret,
          // our rotation records, so a hub that pinned an earlier key can follow the rotation
          ...(env.FED_ROTATIONS ? { "x-fed-rotations": env.FED_ROTATIONS } : {}),
        },
        body: encodeFedSyncPage(env.INSTANCE, built.nextCursor, complete, built.frames, built.nextId) as BodyInit,
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) return { pushed }; // stop; retry next cycle from the same cursor
      // as on the pull side, the id tie-breaker is kept only while more pages of this pass remain
      PUSH_CURSORS.set(ckey, { cursor: built.nextCursor, id: complete ? undefined : built.nextId });
      pushed += built.frames.length;
      if (complete || (built.nextCursor === cursor && built.nextId === id)) break;
      cursor = built.nextCursor;
      id = built.nextId;
    }
  }
  return { pushed };
}
