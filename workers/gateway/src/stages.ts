// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * stages.ts — staged multi-caches. A cache can have ordered stages; stage 0 is the
 * published start, and each later stage's coordinates stay hidden until the finder unlocks the
 * previous stage — by being physically at it (geofence) or after its audio clue. Audio lives in the
 * MEDIA store (R2 on CF, filesystem on Node).
 */
import { nowS } from "./util/time.js";
import type { Env } from "./env.js";
import { json } from "./app.js";
import { mayActAsOwner } from "./auth.js";
import { actor } from "./caches.js";
import { rateLimitedDurable } from "./corroborate_privacy.js";
import { haversineMeters } from "@aprscaching/aprs";
import { STAGE_MIN_CODE_BITS, StageUnlockRequest, codeEntropyBits, sealStage } from "@aprscaching/shared";

interface StageRow {
  stage_no: number;
  unlock: string;
  clue: string | null;
  media_key: string | null;
  lat: number | null;
  lon: number | null;
  radius_m: number;
  unlock_secret: string | null;
}

/** Per hour: NFC code attempts by one finder on one stage, and by everyone on one stage. A tag code is short
 *  enough to type, so guessing it is bounded here rather than by its length. */
const CODE_TRIES_PER_FINDER = 10;
const CODE_TRIES_PER_STAGE = 60;
const HOUR_MS = 3600_000;

/** Normalise an NFC/manual unlock code for comparison (trim + casefold; tag serials/text vary in case). */
const normCode = (s: string) => s.trim().toLowerCase();

/** The owner call of a native cache. An erased owner's withdrawn marker is returned as-is;
 *  {@link mayActAsOwner} lets nobody act for it. */
async function ownerOf(env: Env, cacheId: number): Promise<string | null> {
  const r = await env.DB.prepare("SELECT owner_call FROM caches WHERE id=? AND source='native'")
    .bind(cacheId)
    .first<{ owner_call: string }>();
  return r?.owner_call?.toUpperCase() ?? null;
}
async function unlockedSet(env: Env, cacheId: number, callsign: string): Promise<Set<number>> {
  const rows = (
    await env.DB.prepare("SELECT stage_no FROM stage_unlocks WHERE cache_id=? AND callsign=?")
      .bind(cacheId, callsign.toUpperCase())
      .all<{ stage_no: number }>()
  ).results;
  return new Set(rows.map((r) => r.stage_no));
}

/** Whether a stage unlocks offline, and why not when it does not. */
interface StageOffline {
  stageNo: number;
  offline: boolean;
  reason?: string;
}

/**
 * Seal what unlocking an NFC stage reveals under its tag code, so an offline pack can carry it
 * (packages/shared stageseal.ts); clear it for any other stage, or when the code is too weak to stand up to
 * offline guessing. Runs whenever what a stage reveals changes.
 */
async function resealStage(env: Env, cacheId: number, stageNo: number): Promise<StageOffline> {
  const s = await env.DB.prepare("SELECT * FROM cache_stages WHERE cache_id=? AND stage_no=?")
    .bind(cacheId, stageNo)
    .first<StageRow>();
  const clear = async (reason: string): Promise<StageOffline> => {
    await env.DB.prepare("UPDATE cache_stages SET sealed=NULL WHERE cache_id=? AND stage_no=?")
      .bind(cacheId, stageNo)
      .run();
    return { stageNo, offline: false, reason };
  };
  if (!s || stageNo === 0) return { stageNo, offline: true }; // the published start needs no unlock
  if (s.unlock !== "nfc")
    return clear(s.unlock === "geo" ? "a geo stage checks the finder's position online" : "unlocks online");
  if (!s.unlock_secret) return clear("no tag code set");
  const bits = codeEntropyBits(s.unlock_secret);
  if (bits < STAGE_MIN_CODE_BITS)
    return clear(
      `the tag code is too short to carry offline (about ${bits} bits, ${STAGE_MIN_CODE_BITS} needed): use the tag's serial, or 9 or more random letters and digits`,
    );
  const sealed = await sealStage(s.unlock_secret, {
    lat: s.lat,
    lon: s.lon,
    clue: s.clue,
    mediaUrl: s.media_key ? `/api/media/${s.media_key}` : null,
  });
  await env.DB.prepare("UPDATE cache_stages SET sealed=? WHERE cache_id=? AND stage_no=?")
    .bind(JSON.stringify(sealed), cacheId, stageNo)
    .run();
  return { stageNo, offline: true };
}

// ---- owner: set the stage list (replaces existing) ----
export async function handleSetStages(req: Request, env: Env, cacheId: number): Promise<Response> {
  const b = (await req.json().catch(() => ({}))) as {
    ownerCall?: string;
    stages?: Array<{
      stageNo: number;
      unlock?: string;
      clue?: string;
      lat?: number;
      lon?: number;
      radiusM?: number;
      secret?: string;
    }>;
  };
  const owner = await ownerOf(env, cacheId);
  if (!owner) return json({ error: "unknown cache" }, { status: 404 });
  if (!(await mayActAsOwner(req, env, owner, b.ownerCall)))
    return json({ error: "only the owner may set stages" }, { status: 403 });
  if (!Array.isArray(b.stages)) return json({ error: "stages[] required" }, { status: 400 });

  // Replacing the stage list drops rows that point at stored audio clues — collect those
  // media keys first so we can free the objects afterwards instead of orphaning them in R2/FS forever.
  const orphaned = env.MEDIA
    ? (
        await env.DB.prepare("SELECT media_key FROM cache_stages WHERE cache_id=? AND media_key IS NOT NULL")
          .bind(cacheId)
          .all<{ media_key: string }>()
      ).results
    : [];

  // An unlock belongs to the stage as it was. From the first stage that changes (moved, re-keyed, re-clued,
  // removed or added), finders' unlocks are dropped: a stage reached the old way does not open the new one.
  const before = new Map(
    (
      await env.DB.prepare(
        "SELECT stage_no, unlock, clue, lat, lon, radius_m, unlock_secret FROM cache_stages WHERE cache_id=?",
      )
        .bind(cacheId)
        .all<Omit<StageRow, "media_key">>()
    ).results.map((r) => [r.stage_no, JSON.stringify([r.unlock, r.clue, r.lat, r.lon, r.radius_m, r.unlock_secret])]),
  );
  const after = new Map<number, string>();
  const stmts = [env.DB.prepare("DELETE FROM cache_stages WHERE cache_id=?").bind(cacheId)];
  for (const s of b.stages) {
    const unlock = ["geo", "audio", "open", "nfc"].includes(s.unlock ?? "") ? s.unlock : "geo";
    // for an nfc stage the secret (tag text/serial) is required so it can actually be unlocked
    const secret = unlock === "nfc" ? s.secret?.trim() || null : null;
    after.set(
      s.stageNo,
      JSON.stringify([unlock, s.clue ?? null, s.lat ?? null, s.lon ?? null, Math.round(s.radiusM ?? 60), secret]),
    );
    stmts.push(
      env.DB.prepare(
        "INSERT INTO cache_stages (cache_id, stage_no, unlock, clue, lat, lon, radius_m, unlock_secret) VALUES (?,?,?,?,?,?,?,?)",
      ).bind(
        cacheId,
        s.stageNo,
        unlock,
        s.clue ?? null,
        s.lat ?? null,
        s.lon ?? null,
        Math.round(s.radiusM ?? 60),
        secret,
      ),
    );
  }
  const changed = [...new Set([...before.keys(), ...after.keys()])].filter((n) => before.get(n) !== after.get(n));
  if (changed.length)
    stmts.push(
      env.DB.prepare("DELETE FROM stage_unlocks WHERE cache_id=? AND stage_no >= ?").bind(
        cacheId,
        Math.min(...changed),
      ),
    );
  await env.DB.batch(stmts);
  // free the now-orphaned clue objects (best-effort; the rows are already gone)
  for (const m of orphaned) {
    try {
      await env.MEDIA!.delete?.(m.media_key);
    } catch {
      /* best-effort */
    }
  }
  // which stages a finder can unlock without a connection, and why not the others
  const offline: StageOffline[] = [];
  for (const s of b.stages) offline.push(await resealStage(env, cacheId, s.stageNo));
  return json({ ok: true, stages: b.stages.length, offline });
}

// ---- owner: upload an audio clue for a stage ----
export async function handleStageMedia(req: Request, env: Env, cacheId: number, stageNo: number): Promise<Response> {
  if (!env.MEDIA) return json({ error: "media storage not configured" }, { status: 501 });
  const owner = await ownerOf(env, cacheId);
  if (!owner) return json({ error: "unknown cache" }, { status: 404 });
  if (!(await mayActAsOwner(req, env, owner, req.headers.get("x-owner-call"))))
    return json({ error: "only the owner may upload media" }, { status: 403 });

  const ct = req.headers.get("content-type") ?? "application/octet-stream";
  if (!/^audio\//.test(ct)) return json({ error: "expected an audio/* body" }, { status: 415 });
  const bytes = new Uint8Array(await req.arrayBuffer());
  if (!bytes.length || bytes.length > 5_000_000) return json({ error: "empty or >5MB" }, { status: 413 });
  const ext = ct.split("/")[1]?.split(";")[0] ?? "bin";
  const key = `cache/${cacheId}/stage/${stageNo}/clue.${ext}`;
  await env.MEDIA.put(key, bytes, ct);
  await env.DB.prepare("UPDATE cache_stages SET media_key=? WHERE cache_id=? AND stage_no=?")
    .bind(key, cacheId, stageNo)
    .run();
  await resealStage(env, cacheId, stageNo); // the sealed payload names the audio clue
  return json({ ok: true, mediaKey: key });
}

// ---- serve a media clue (public; the clue is meant to be heard) ----
export async function handleGetMedia(req: Request, env: Env, key: string): Promise<Response> {
  if (!env.MEDIA) return new Response("media not configured", { status: 501 });
  const obj = await env.MEDIA.get(key);
  if (!obj) return new Response("not found", { status: 404 });
  return new Response(obj.bytes as unknown as BodyInit, {
    headers: { "content-type": obj.contentType, "cache-control": "public, max-age=86400" },
  });
}

// ---- list stages (coords hidden unless stage 0 or unlocked by the caller) ----
export async function handleGetStages(req: Request, env: Env, cacheId: number): Promise<Response> {
  // the caller's own unlocks only: `?callsign=` names someone else only with the ingest secret
  const callsign = await actor(req, env, new URL(req.url).searchParams.get("callsign") ?? undefined);
  const rows = (
    await env.DB.prepare(
      "SELECT stage_no, unlock, clue, media_key, lat, lon, radius_m, unlock_secret FROM cache_stages WHERE cache_id=? ORDER BY stage_no",
    )
      .bind(cacheId)
      .all<StageRow>()
  ).results;
  const unlocked = callsign ? await unlockedSet(env, cacheId, callsign) : new Set<number>();
  // the owner sees every stage as set, tag codes included, to edit them
  const owner = await ownerOf(env, cacheId);
  const isOwner = !!owner && (await mayActAsOwner(req, env, owner));
  return json({
    stages: rows.map((r) => {
      const open = isOwner || r.stage_no === 0 || unlocked.has(r.stage_no);
      return {
        ...(isOwner && { secret: r.unlock_secret }),
        stageNo: r.stage_no,
        unlock: r.unlock,
        clue: r.clue,
        mediaUrl: r.media_key ? `/api/media/${r.media_key}` : null,
        radiusM: r.radius_m,
        unlocked: open,
        lat: open ? r.lat : null,
        lon: open ? r.lon : null,
      };
    }),
  });
}

// ---- unlock a stage: reveal its coords once the prerequisite is met ----
export async function handleUnlockStage(req: Request, env: Env, cacheId: number, stageNo: number): Promise<Response> {
  // `appGeo` is the device's own reading; the strict shape refuses anything that marks a typed coordinate
  const parsed = StageUnlockRequest.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return json({ error: "bad request", issues: parsed.error.issues }, { status: 400 });
  const b = parsed.data;
  const cs = await actor(req, env, b.callsign);
  if (!cs) return json({ error: "sign in to unlock a stage" }, { status: 401 });
  if (stageNo <= 0) return json({ error: "stage 0 is the public start" }, { status: 400 });

  const stage = await env.DB.prepare("SELECT * FROM cache_stages WHERE cache_id=? AND stage_no=?")
    .bind(cacheId, stageNo)
    .first<StageRow>();
  if (!stage) return json({ error: "no such stage" }, { status: 404 });
  const prev = await env.DB.prepare("SELECT * FROM cache_stages WHERE cache_id=? AND stage_no=?")
    .bind(cacheId, stageNo - 1)
    .first<StageRow>();
  if (!prev) return json({ error: "previous stage missing" }, { status: 409 });

  // must have reached the previous stage first
  const unlocked = await unlockedSet(env, cacheId, cs);
  if (stageNo - 1 > 0 && !unlocked.has(stageNo - 1))
    return json({ error: "reach the previous stage first", needStage: stageNo - 1 }, { status: 403 });

  // geofence gate: be within the previous stage's radius
  if (stage.unlock === "geo") {
    if (!b.appGeo) return json({ error: "in-app location required to unlock", reason: "no_geo" }, { status: 403 });
    if (prev.lat == null || prev.lon == null)
      return json({ error: "previous stage has no coordinates" }, { status: 409 });
    const d = haversineMeters(b.appGeo.lat, b.appGeo.lon, prev.lat, prev.lon);
    if (d > prev.radius_m)
      return json(
        { unlocked: false, reason: "too_far", distanceM: Math.round(d), radiusM: prev.radius_m },
        { status: 403 },
      );
  }
  // nfc gate: present the tag's secret (scanned via WebNFC or typed as the manual-code fallback)
  if (stage.unlock === "nfc") {
    if (!stage.unlock_secret)
      return json({ error: "this NFC stage has no tag configured", reason: "no_tag" }, { status: 409 });
    if (!b.code) return json({ error: "scan the NFC tag or enter its code", reason: "no_code" }, { status: 403 });
    const t = Date.now();
    if (
      (await rateLimitedDurable(env, `stage-code:${cacheId}:${stageNo}:${cs}`, t, CODE_TRIES_PER_FINDER, HOUR_MS)) ||
      (await rateLimitedDurable(env, `stage-code:${cacheId}:${stageNo}`, t, CODE_TRIES_PER_STAGE, HOUR_MS))
    )
      return json({ error: "too many tries on this tag — try again in an hour", reason: "limited" }, { status: 429 });
    if (normCode(b.code) !== normCode(stage.unlock_secret))
      return json({ unlocked: false, reason: "bad_code" }, { status: 403 });
  }
  // 'audio'/'open' unlock on request (the audio clue is an advisory gate)

  await env.DB.prepare(
    "INSERT OR IGNORE INTO stage_unlocks (callsign, cache_id, stage_no, unlocked_at) VALUES (?,?,?,?)",
  )
    .bind(cs, cacheId, stageNo, nowS())
    .run();
  return json({
    unlocked: true,
    stageNo,
    lat: stage.lat,
    lon: stage.lon,
    clue: stage.clue,
    mediaUrl: stage.media_key ? `/api/media/${stage.media_key}` : null,
  });
}

// ---- cache media gallery: owner-managed images/audio/files on a cache ----
const MEDIA_LIMIT = 10_000_000; // 10 MB per item
function mediaKind(ct: string): "image" | "audio" | "file" {
  if (/^image\//.test(ct)) return "image";
  if (/^audio\//.test(ct)) return "audio";
  return "file";
}

/** List a cache's media (public — attachments are meant to be seen/heard). */
export async function handleListCacheMedia(req: Request, env: Env, cacheId: number): Promise<Response> {
  const rows = (
    await env.DB.prepare(
      "SELECT id, media_key, kind, content_type, title, bytes, created_at, thumb_key, thumb_bytes FROM cache_media WHERE cache_id=? ORDER BY created_at",
    )
      .bind(cacheId)
      .all<{
        id: number;
        media_key: string;
        kind: string;
        content_type: string;
        title: string | null;
        bytes: number;
        created_at: number;
        thumb_key: string | null;
        thumb_bytes: number | null;
      }>()
  ).results;
  return json({
    media: rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      contentType: r.content_type,
      title: r.title,
      url: `/api/media/${r.media_key}`,
      bytes: r.bytes,
      createdAt: r.created_at,
      ...(r.thumb_key && { thumbUrl: `/api/media/${r.thumb_key}`, thumbBytes: r.thumb_bytes }),
    })),
  });
}

/** Owner uploads a media item (raw body; ?title= optional). */
export async function handleAddCacheMedia(req: Request, env: Env, cacheId: number): Promise<Response> {
  if (!env.MEDIA) return json({ error: "media storage not configured" }, { status: 501 });
  const owner = await ownerOf(env, cacheId);
  if (!owner) return json({ error: "unknown cache" }, { status: 404 });
  if (!(await mayActAsOwner(req, env, owner, req.headers.get("x-owner-call"))))
    return json({ error: "only the owner may add media" }, { status: 403 });

  const ct = (req.headers.get("content-type") ?? "application/octet-stream").split(";")[0]!.trim();
  const bytes = new Uint8Array(await req.arrayBuffer());
  if (!bytes.length || bytes.length > MEDIA_LIMIT)
    return json({ error: `empty or >${MEDIA_LIMIT / 1_000_000}MB` }, { status: 413 });
  const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM cache_media WHERE cache_id=?")
    .bind(cacheId)
    .first<{ n: number }>();
  if ((count?.n ?? 0) >= 20) return json({ error: "media limit reached (20 per cache)" }, { status: 409 });

  const kind = mediaKind(ct);
  const ext = ct.split("/")[1] ?? "bin";
  const key = `cache/${cacheId}/media/${crypto.randomUUID()}.${ext}`;
  const title = new URL(req.url).searchParams.get("title")?.slice(0, 120) ?? null;
  await env.MEDIA.put(key, bytes, ct);
  const ins = await env.DB.prepare(
    "INSERT INTO cache_media (cache_id, media_key, kind, content_type, title, bytes, created_at) VALUES (?,?,?,?,?,?,?)",
  )
    .bind(cacheId, key, kind, ct, title, bytes.length, nowS())
    .run();
  return json(
    {
      item: {
        id: Number(ins.meta.last_row_id),
        kind,
        contentType: ct,
        title,
        url: `/api/media/${key}`,
        bytes: bytes.length,
      },
    },
    { status: 201 },
  );
}

/** The largest thumbnail an owner may store: a 320-pixel JPEG or WebP is well under it. */
const THUMB_LIMIT = 150_000;

/**
 * PUT /api/caches/:id/media/:mediaId/thumb — the owner stores the small copy of an image, which the
 * uploader's browser made (raw JPEG or WebP body). The gallery and offline packs load it instead of the
 * image as published. A new one replaces the old.
 */
export async function handlePutMediaThumb(req: Request, env: Env, cacheId: number, mediaId: number): Promise<Response> {
  if (!env.MEDIA) return json({ error: "media storage not configured" }, { status: 501 });
  const owner = await ownerOf(env, cacheId);
  if (!owner) return json({ error: "unknown cache" }, { status: 404 });
  if (!(await mayActAsOwner(req, env, owner, req.headers.get("x-owner-call"))))
    return json({ error: "only the owner may add media" }, { status: 403 });
  const row = await env.DB.prepare("SELECT kind, thumb_key FROM cache_media WHERE id=? AND cache_id=?")
    .bind(mediaId, cacheId)
    .first<{ kind: string; thumb_key: string | null }>();
  if (!row) return json({ error: "no such media" }, { status: 404 });
  if (row.kind !== "image") return json({ error: "only an image has a thumbnail" }, { status: 400 });
  const ct = (req.headers.get("content-type") ?? "").split(";")[0]!.trim();
  if (ct !== "image/jpeg" && ct !== "image/webp")
    return json({ error: "a thumbnail is image/jpeg or image/webp" }, { status: 415 });
  const bytes = new Uint8Array(await req.arrayBuffer());
  if (!bytes.length || bytes.length > THUMB_LIMIT)
    return json({ error: `a thumbnail is at most ${THUMB_LIMIT / 1000} kB` }, { status: 413 });
  const key = `cache/${cacheId}/media/${crypto.randomUUID()}.thumb.${ct === "image/webp" ? "webp" : "jpeg"}`;
  await env.MEDIA.put(key, bytes, ct);
  await env.DB.prepare("UPDATE cache_media SET thumb_key=?, thumb_bytes=? WHERE id=?")
    .bind(key, bytes.length, mediaId)
    .run();
  if (row.thumb_key) await env.MEDIA.delete?.(row.thumb_key).catch(() => {});
  return json({ thumbUrl: `/api/media/${key}`, thumbBytes: bytes.length });
}

/** Owner deletes a media item (removes the row + best-effort the stored object). */
export async function handleDeleteCacheMedia(
  req: Request,
  env: Env,
  cacheId: number,
  mediaId: number,
): Promise<Response> {
  const owner = await ownerOf(env, cacheId);
  if (!owner) return json({ error: "unknown cache" }, { status: 404 });
  if (!(await mayActAsOwner(req, env, owner, req.headers.get("x-owner-call"))))
    return json({ error: "only the owner may delete media" }, { status: 403 });
  const row = await env.DB.prepare("SELECT media_key, thumb_key FROM cache_media WHERE id=? AND cache_id=?")
    .bind(mediaId, cacheId)
    .first<{ media_key: string; thumb_key: string | null }>();
  if (!row) return json({ error: "no such media" }, { status: 404 });
  await env.DB.prepare("DELETE FROM cache_media WHERE id=?").bind(mediaId).run();
  for (const key of [row.media_key, row.thumb_key])
    try {
      if (key) await env.MEDIA?.delete?.(key);
    } catch {
      /* best-effort; row gone either way */
    }
  return json({ ok: true });
}

/** Count stages for a cache (so the detail endpoint can flag multi-stage caches). */
export async function stageCount(env: Env, cacheId: number): Promise<number> {
  const r = await env.DB.prepare("SELECT COUNT(*) AS n FROM cache_stages WHERE cache_id=?")
    .bind(cacheId)
    .first<{ n: number }>();
  return r?.n ?? 0;
}
