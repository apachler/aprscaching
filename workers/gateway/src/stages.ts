// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * stages.ts — staged multi-caches. A cache can have ordered stages; stage 0 is the
 * published start, and each later stage's coordinates stay hidden until the finder unlocks the
 * previous stage — by being physically at it (geofence) or after its audio clue. Audio lives in the
 * MEDIA store (the server's filesystem).
 */
import { nowS } from "./util/time.js";
import type { Env } from "./env.js";
import { json } from "./http.js";
import { readCappedBody } from "./fetchguard.js";
import { mayActAsOwner } from "./auth.js";
import { actor } from "./caches.js";
import { rateLimitedDurable } from "./corroborate_privacy.js";
import { CACHE_POINT, moveRefusal, placePins } from "./cacheplace.js";
import { removedCacheResponse } from "./moderation.js";
import { baseCall, haversineMeters } from "@aprscaching/aprs";
import {
  MEDIA_LIMITS,
  STAGE_MIN_CODE_BITS,
  StageUnlockRequest,
  codeEntropyBits,
  mediaMB,
  sealStage,
} from "@aprscaching/shared";

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
/** Is the cache one the sysop removed? Its stages and media stay as they are until the sysop restores it. */
async function isRemoved(env: Env, cacheId: number): Promise<boolean> {
  const r = await env.DB.prepare("SELECT removed_at FROM caches WHERE id=?")
    .bind(cacheId)
    .first<{ removed_at: number | null }>();
  return r?.removed_at != null;
}
const REMOVED_REFUSAL = () => json({ error: "the sysop removed this cache — it cannot be edited" }, { status: 403 });
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
export async function resealStage(env: Env, cacheId: number, stageNo: number): Promise<StageOffline> {
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
      /** The number this stage had before the edit, when the owner moved it; its clip follows it. */
      prevStageNo?: number;
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
  if (await isRemoved(env, cacheId)) return REMOVED_REFUSAL();
  if (!Array.isArray(b.stages)) return json({ error: "stages[] required" }, { status: 400 });

  const rows = (
    await env.DB.prepare(
      "SELECT stage_no, unlock, clue, lat, lon, radius_m, unlock_secret, media_key, media_bytes FROM cache_stages WHERE cache_id=?",
    )
      .bind(cacheId)
      .all<StageRow & { media_bytes: number | null }>()
  ).results;
  // An unlock belongs to the stage as it was. From the first stage that changes (moved, re-keyed, re-clued,
  // removed or added), finders' unlocks are dropped: a stage reached the old way does not open the new one.
  const before = new Map(
    rows.map((r) => [r.stage_no, JSON.stringify([r.unlock, r.clue, r.lat, r.lon, r.radius_m, r.unlock_secret])]),
  );
  // A stage's audio clue stays with it while the stage stays, unless it stops being an audio stage; a stage the
  // owner moved (`prevStageNo`, when one before it was removed) takes its clue along. A clue whose stage is gone,
  // or turned into another kind, is freed, so no stored object outlives the row that counts it.
  const clips = new Map(
    rows.filter((r) => r.media_key).map((r) => [r.stage_no, { ...r, media_key: r.media_key! }] as const),
  );
  // A found cache's stages stay near where they were found: each pinned stage carries on as the stage that names
  // it (its number, or `prevStageNo` when renumbered) within the move limit, and none is dropped. A stage added
  // since the last find is free until a find pins it.
  const pins = await placePins(env, cacheId);
  const carried = new Map<number, number>(); // the old stage number → the new one carrying its pin
  // a stage naming its old number claims that pin before one that only shares the number
  const claims = [
    ...b.stages.filter((s) => Number.isInteger(s.prevStageNo)).map((s) => [s.prevStageNo!, s] as const),
    ...b.stages.filter((s) => !Number.isInteger(s.prevStageNo)).map((s) => [s.stageNo, s] as const),
  ];
  for (const [from, s] of claims) {
    if (from === CACHE_POINT || !pins.has(from) || carried.has(from)) continue;
    carried.set(from, s.stageNo);
    const to = Number.isFinite(s.lat) && Number.isFinite(s.lon) ? { lat: s.lat!, lon: s.lon! } : null;
    const tooFar = moveRefusal(env, `Stage ${s.stageNo}`, pins.get(from), to);
    if (tooFar) return json({ error: tooFar }, { status: 409 });
  }
  const dropped = [...pins.keys()].find((n) => n !== CACHE_POINT && !carried.has(n));
  if (dropped !== undefined)
    return json(
      {
        error: `Stage ${dropped} has been found, so it stays part of the cache. Archive the cache and hide a new one to change its route.`,
      },
      { status: 409 },
    );
  /** The clues kept, by the stage number they had. */
  const kept = new Map<number, { media_key: string; media_bytes: number | null }>();
  const after = new Map<number, string>();
  const stmts = [env.DB.prepare("DELETE FROM cache_stages WHERE cache_id=?").bind(cacheId)];
  for (const s of b.stages) {
    const unlock = ["geo", "audio", "open", "nfc"].includes(s.unlock ?? "") ? s.unlock : "geo";
    // for an nfc stage the secret (tag text/serial) is required so it can actually be unlocked
    const secret = unlock === "nfc" ? s.secret?.trim() || null : null;
    const from = Number.isInteger(s.prevStageNo) ? s.prevStageNo! : s.stageNo;
    const clip = clips.get(from);
    const media = clip && !kept.has(from) && (clip.unlock !== "audio" || unlock === "audio") ? clip : undefined;
    if (media) kept.set(from, media);
    after.set(
      s.stageNo,
      JSON.stringify([unlock, s.clue ?? null, s.lat ?? null, s.lon ?? null, Math.round(s.radiusM ?? 60), secret]),
    );
    stmts.push(
      env.DB.prepare(
        "INSERT INTO cache_stages (cache_id, stage_no, unlock, clue, lat, lon, radius_m, unlock_secret, media_key, media_bytes) VALUES (?,?,?,?,?,?,?,?,?,?)",
      ).bind(
        cacheId,
        s.stageNo,
        unlock,
        s.clue ?? null,
        s.lat ?? null,
        s.lon ?? null,
        Math.round(s.radiusM ?? 60),
        secret,
        media?.media_key ?? null,
        media?.media_bytes ?? null,
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
  // the pins follow their stages to the numbers they have now
  if (carried.size) {
    const at = nowS();
    stmts.push(env.DB.prepare("DELETE FROM cache_place_pins WHERE cache_id=? AND stage_no>=0").bind(cacheId));
    for (const [from, to] of carried) {
      const pin = pins.get(from)!;
      stmts.push(
        env.DB.prepare(
          "INSERT INTO cache_place_pins (cache_id, stage_no, lat, lon, pinned_at) VALUES (?,?,?,?,?)",
        ).bind(cacheId, to, pin.lat, pin.lon, at),
      );
    }
  }
  await env.DB.batch(stmts);
  // free the clue objects no row holds any more (best-effort; the rows are already gone)
  for (const [n, clip] of clips) if (!kept.has(n)) await dropObject(env, clip.media_key);
  // which stages a finder can unlock without a connection, and why not the others
  const offline: StageOffline[] = [];
  for (const s of b.stages) offline.push(await resealStage(env, cacheId, s.stageNo));
  return json({ ok: true, stages: b.stages.length, offline });
}

/** Remove a stored object no row refers to any more; best-effort, since the rows already let it go. */
async function dropObject(env: Env, key: string): Promise<void> {
  try {
    await env.MEDIA?.delete?.(key);
  } catch {
    /* best-effort */
  }
}

// ---- owner: upload an audio clue for a stage ----
export async function handleStageMedia(req: Request, env: Env, cacheId: number, stageNo: number): Promise<Response> {
  if (!env.MEDIA) return json({ error: "media storage not configured" }, { status: 501 });
  const owner = await ownerOf(env, cacheId);
  if (!owner) return json({ error: "unknown cache" }, { status: 404 });
  if (!(await mayActAsOwner(req, env, owner, req.headers.get("x-owner-call"))))
    return json({ error: "only the owner may upload media" }, { status: 403 });
  if (await isRemoved(env, cacheId)) return REMOVED_REFUSAL();

  // the clue hangs on a stage row: without one, a stored object would be counted by nothing and freed by nothing
  const before = await env.DB.prepare("SELECT media_key, media_bytes FROM cache_stages WHERE cache_id=? AND stage_no=?")
    .bind(cacheId, stageNo)
    .first<{ media_key: string | null; media_bytes: number | null }>();
  if (!before) return json({ error: "unknown stage" }, { status: 404 });

  const ct = mediaType(req.headers.get("content-type"));
  if (!AUDIO_TYPES.has(ct)) return json({ error: "an audio clue is a sound (MP3, Ogg, WAV, M4A)" }, { status: 415 });
  const bytes = await readCappedBody(req, MEDIA_LIMITS.audio);
  if (!bytes?.length)
    return json({ error: `an audio clue is at most ${mediaMB(MEDIA_LIMITS.audio)}` }, { status: 413 });
  const full = await mediaRefusal(env, cacheId, owner, bytes.length, before.media_bytes ?? 0);
  if (full) return json({ error: full }, { status: 413 });
  const ext = ct.split("/")[1]?.split(";")[0] ?? "bin";
  // Each upload gets its own key: a clip is served cacheable for a day, so a replaced one must not answer at
  // the old URL, and the previous object is freed once the row names the new one.
  const tag = [...crypto.getRandomValues(new Uint8Array(6))].map((x) => x.toString(16).padStart(2, "0")).join("");
  const key = `cache/${cacheId}/stage/${stageNo}/clue-${tag}.${ext}`;
  await env.MEDIA.put(key, bytes, ct);
  await env.DB.prepare("UPDATE cache_stages SET media_key=?, media_bytes=? WHERE cache_id=? AND stage_no=?")
    .bind(key, bytes.length, cacheId, stageNo)
    .run();
  if (before.media_key && before.media_key !== key) await dropObject(env, before.media_key);
  await resealStage(env, cacheId, stageNo); // the sealed payload names the audio clue
  return json({ ok: true, mediaKey: key });
}

/**
 * What a finder sees of a stage before unlocking it: the start, and an audio stage, whose clip is the puzzle that
 * opens it, show their clue; any other stage's clue is part of what unlocking reveals.
 */
const clueShownLocked = (s: { stage_no: number; unlock: string | null }) => s.stage_no === 0 || s.unlock === "audio";

// ---- serve a media clue: a stage's clip follows its clue, other cache media is public ----
/** The exact key shapes the server stores media under — a gallery item, its thumbnail, a stage's audio clue.
 *  Only these are served: a key with an empty or dot segment could name the same object as a gated clue
 *  while slipping past the stage pattern below. */
const SERVED_MEDIA_KEY =
  /^cache\/[1-9]\d*\/(?:media\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?:\.thumb)?|stage\/(?:0|[1-9]\d*)\/clue-[0-9a-f]{12})\.[a-z0-9-]{1,16}$/;

export async function handleGetMedia(req: Request, env: Env, key: string): Promise<Response> {
  if (!env.MEDIA) return new Response("media not configured", { status: 501 });
  if (!SERVED_MEDIA_KEY.test(key)) return new Response("not found", { status: 404 });
  let cacheControl = "public, max-age=86400";
  // a removed cache's media answers its owner and the sysop only, and never from a shared cache
  const mediaCacheId = Number(key.split("/")[1]);
  if (await isRemoved(env, mediaCacheId)) {
    if (await removedCacheResponse(req, env, mediaCacheId)) return new Response("not found", { status: 404 });
    cacheControl = "private, no-store";
  }
  const stageKey = /^cache\/(\d+)\/stage\/(\d+)\//.exec(key);
  if (stageKey) {
    const cacheId = Number(stageKey[1]);
    // The clip answers for the stage that holds it now: a stage the owner moved keeps the key it was stored under.
    const st = await env.DB.prepare("SELECT stage_no, unlock FROM cache_stages WHERE cache_id=? AND media_key=?")
      .bind(cacheId, key)
      .first<{ stage_no: number; unlock: string | null }>();
    if (!st) return new Response("not found", { status: 404 });
    if (!clueShownLocked(st)) {
      const owner = await ownerOf(env, cacheId);
      // the caller's own unlocks: `?callsign=` names someone else only with the ingest secret
      const cs = await actor(req, env, new URL(req.url).searchParams.get("callsign") ?? undefined);
      const allowed =
        (!!owner && (await mayActAsOwner(req, env, owner))) ||
        (!!cs && (await unlockedSet(env, cacheId, cs)).has(st.stage_no));
      if (!allowed) return new Response("not found", { status: 404 });
      cacheControl = "private, no-store"; // the clip is the finder's once unlocked, never a shared cache's
    }
  }
  const obj = await env.MEDIA.get(key);
  if (!obj) return new Response("not found", { status: 404 });
  // Served inert whatever it holds: no sniffing, no script, no frame, and anything not a photo or a sound only
  // as a download.
  const ct = mediaType(obj.contentType);
  const playable = !!mediaKind(ct);
  return new Response(obj.bytes as unknown as BodyInit, {
    headers: {
      "content-type": playable ? ct : "application/octet-stream",
      "cache-control": cacheControl,
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
      ...(playable ? {} : { "content-disposition": "attachment" }),
    },
  });
}

// ---- list stages (coords hidden unless stage 0 or unlocked by the caller) ----
export async function handleGetStages(req: Request, env: Env, cacheId: number): Promise<Response> {
  const hidden = await removedCacheResponse(req, env, cacheId);
  if (hidden) return hidden;
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
      const clue = open || clueShownLocked(r);
      return {
        ...(isOwner && { secret: r.unlock_secret }),
        stageNo: r.stage_no,
        unlock: r.unlock,
        clue: clue ? r.clue : null,
        mediaUrl: clue && r.media_key ? `/api/media/${r.media_key}` : null,
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
  if (await isRemoved(env, cacheId)) return json({ error: "no such cache" }, { status: 404 });

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
    return json(
      { error: "reach the previous stage first", reason: "previous_stage", needStage: stageNo - 1 },
      { status: 403 },
    );

  // geofence gate: be within the previous stage's radius
  if (stage.unlock === "geo") {
    if (!b.appGeo) return json({ error: "in-app location required to unlock", reason: "no_geo" }, { status: 403 });
    if (prev.lat == null || prev.lon == null)
      return json({ error: "previous stage has no coordinates" }, { status: 409 });
    const d = haversineMeters(b.appGeo.lat, b.appGeo.lon, prev.lat, prev.lon);
    if (d > prev.radius_m)
      return json(
        {
          error: `too far: ${Math.round(d)} m from the stage before, ${prev.radius_m} m needed`,
          unlocked: false,
          reason: "too_far",
          distanceM: Math.round(d),
          radiusM: prev.radius_m,
        },
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
      return json(
        { error: "that code does not match this stage's tag", unlocked: false, reason: "bad_code" },
        { status: 403 },
      );
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

// ---- how much media an instance holds ----
/** The instance's own ceiling, `MEDIA_QUOTA_MB`, is what its storage can spare; MEDIA_LIMITS bounds the rest. */
const MEDIA_QUOTA_MB_DEFAULT = 1024;
const quotaBytes = (env: Env) => (Number(env.MEDIA_QUOTA_MB) || MEDIA_QUOTA_MB_DEFAULT) * 1_000_000;

/** Gallery bytes (thumbnails included) plus audio clues, over the caches a WHERE clause on `c` selects. */
const mediaBytesSql = (where: string) =>
  `SELECT
     (SELECT COALESCE(SUM(m.bytes + COALESCE(m.thumb_bytes, 0)), 0) FROM cache_media m JOIN caches c ON c.id = m.cache_id WHERE ${where})
   + (SELECT COALESCE(SUM(COALESCE(s.media_bytes, 0)), 0) FROM cache_stages s JOIN caches c ON c.id = s.cache_id WHERE ${where})
   AS n`;
const ownerBase =
  "UPPER(CASE WHEN instr(c.owner_call, '-') > 0 THEN substr(c.owner_call, 1, instr(c.owner_call, '-') - 1) ELSE c.owner_call END)";

/**
 * Why `adding` more bytes of media on a cache does not fit, or null when it does. `freeing` is what the upload
 * replaces (a stage's previous clue). Checks the cache, the account that owns it, and the instance.
 */
async function mediaRefusal(
  env: Env,
  cacheId: number,
  owner: string,
  adding: number,
  freeing = 0,
): Promise<string | null> {
  const sum = async (where: string, ...binds: (string | number)[]) =>
    (
      await env.DB.prepare(mediaBytesSql(where))
        .bind(...binds, ...binds)
        .first<{ n: number }>()
    )?.n ?? 0;
  const delta = adding - freeing;
  if ((await sum("c.id = ?", cacheId)) + delta > MEDIA_LIMITS.cache)
    return `this cache holds at most ${mediaMB(MEDIA_LIMITS.cache)} of media`;
  const base = baseCall(owner);
  const calls = (
    await env.DB.prepare(
      "SELECT callsign FROM account_callsigns WHERE account_id = (SELECT account_id FROM account_callsigns WHERE callsign = ?)",
    )
      .bind(base)
      .all<{ callsign: string }>()
  ).results.map((r) => r.callsign.toUpperCase());
  const held = calls.length ? calls : [base];
  if ((await sum(`${ownerBase} IN (${held.map(() => "?").join(",")})`, ...held)) + delta > MEDIA_LIMITS.account)
    return `your caches hold at most ${mediaMB(MEDIA_LIMITS.account)} of media together`;
  if ((await sum("1 = 1")) + delta > quotaBytes(env)) return "this instance's media storage is full: ask the sysop";
  return null;
}

// ---- cache media gallery: owner-managed images and audio on a cache ----
/**
 * The media an instance stores and serves: photos and sound, nothing a browser runs. A type outside this list
 * (a page, a script, an SVG drawing) would play out in the instance's own origin for whoever opens the link.
 */
const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif", "image/avif"]);
const AUDIO_TYPES = new Set([
  "audio/mpeg",
  "audio/mp3",
  "audio/ogg",
  "audio/opus",
  "audio/wav",
  "audio/x-wav",
  "audio/wave",
  "audio/aac",
  "audio/mp4",
  "audio/x-m4a",
  "audio/webm",
]);
const mediaType = (ct: string | null) => (ct ?? "").split(";")[0]!.trim().toLowerCase();
function mediaKind(ct: string): "image" | "audio" | null {
  if (IMAGE_TYPES.has(ct)) return "image";
  if (AUDIO_TYPES.has(ct)) return "audio";
  return null;
}

/** List a cache's media (public — attachments are meant to be seen/heard). */
export async function handleListCacheMedia(req: Request, env: Env, cacheId: number): Promise<Response> {
  const hidden = await removedCacheResponse(req, env, cacheId);
  if (hidden) return hidden;
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
  if (await isRemoved(env, cacheId)) return REMOVED_REFUSAL();

  const ct = mediaType(req.headers.get("content-type"));
  const kind = mediaKind(ct);
  if (!kind)
    return json(
      { error: "media must be a photo or a sound (JPEG, PNG, WebP, GIF, AVIF, MP3, Ogg, WAV, M4A)" },
      { status: 415 },
    );
  const max = MEDIA_LIMITS[kind];
  const bytes = await readCappedBody(req, max);
  if (!bytes?.length)
    return json({ error: `${kind === "image" ? "a photo" : "a sound"} is at most ${mediaMB(max)}` }, { status: 413 });
  const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM cache_media WHERE cache_id=?")
    .bind(cacheId)
    .first<{ n: number }>();
  if ((count?.n ?? 0) >= MEDIA_LIMITS.items)
    return json({ error: `a cache holds at most ${MEDIA_LIMITS.items} media items` }, { status: 409 });
  const full = await mediaRefusal(env, cacheId, owner, bytes.length);
  if (full) return json({ error: full }, { status: 413 });

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
  if (await isRemoved(env, cacheId)) return REMOVED_REFUSAL();
  const row = await env.DB.prepare("SELECT kind, thumb_key FROM cache_media WHERE id=? AND cache_id=?")
    .bind(mediaId, cacheId)
    .first<{ kind: string; thumb_key: string | null }>();
  if (!row) return json({ error: "no such media" }, { status: 404 });
  if (row.kind !== "image") return json({ error: "only an image has a thumbnail" }, { status: 400 });
  const ct = (req.headers.get("content-type") ?? "").split(";")[0]!.trim();
  if (ct !== "image/jpeg" && ct !== "image/webp")
    return json({ error: "a thumbnail is image/jpeg or image/webp" }, { status: 415 });
  const bytes = await readCappedBody(req, THUMB_LIMIT);
  if (!bytes?.length) return json({ error: `a thumbnail is at most ${THUMB_LIMIT / 1000} kB` }, { status: 413 });
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
