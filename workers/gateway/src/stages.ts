/**
 * stages.ts — M2 audio-cache: staged multi-caches. A cache can have ordered stages; stage 0 is the
 * published start, and each later stage's coordinates stay hidden until the finder unlocks the
 * previous stage — by being physically at it (geofence) or after its audio clue. Audio lives in the
 * MEDIA store (R2 on CF, filesystem on Node).
 */
import type { Env } from "./env.js";
import { json } from "./app.js";
import { actor } from "./caches.js";
import { haversineMeters } from "@aprsweb/aprs";

const now = () => Math.floor(Date.now() / 1000);

interface StageRow { stage_no: number; unlock: string; clue: string | null; media_key: string | null; lat: number | null; lon: number | null; radius_m: number }

async function ownerOf(env: Env, cacheId: number): Promise<string | null> {
  const r = await env.DB.prepare("SELECT owner_call FROM caches WHERE id=? AND source='native'").bind(cacheId).first<{ owner_call: string }>();
  return r?.owner_call?.toUpperCase() ?? null;
}
async function unlockedSet(env: Env, cacheId: number, callsign: string): Promise<Set<number>> {
  const rows = (await env.DB.prepare("SELECT stage_no FROM stage_unlocks WHERE cache_id=? AND callsign=?").bind(cacheId, callsign.toUpperCase()).all<{ stage_no: number }>()).results;
  return new Set(rows.map((r) => r.stage_no));
}

// ---- owner: set the stage list (replaces existing) ----
export async function handleSetStages(req: Request, env: Env, cacheId: number): Promise<Response> {
  const b = (await req.json().catch(() => ({}))) as { ownerCall?: string; stages?: Array<{ stageNo: number; unlock?: string; clue?: string; lat?: number; lon?: number; radiusM?: number }> };
  const owner = await ownerOf(env, cacheId);
  if (!owner) return json({ error: "unknown cache" }, { status: 404 });
  const who = await actor(req, env, b.ownerCall);
  if (!who || who !== owner) return json({ error: "only the owner may set stages" }, { status: 403 });
  if (!Array.isArray(b.stages)) return json({ error: "stages[] required" }, { status: 400 });

  const stmts = [env.DB.prepare("DELETE FROM cache_stages WHERE cache_id=?").bind(cacheId)];
  for (const s of b.stages) {
    const unlock = ["geo", "audio", "open"].includes(s.unlock ?? "") ? s.unlock : "geo";
    stmts.push(env.DB.prepare(
      "INSERT INTO cache_stages (cache_id, stage_no, unlock, clue, lat, lon, radius_m) VALUES (?,?,?,?,?,?,?)",
    ).bind(cacheId, s.stageNo, unlock, s.clue ?? null, s.lat ?? null, s.lon ?? null, Math.round(s.radiusM ?? 60)));
  }
  await env.DB.batch(stmts);
  return json({ ok: true, stages: b.stages.length });
}

// ---- owner: upload an audio clue for a stage ----
export async function handleStageMedia(req: Request, env: Env, cacheId: number, stageNo: number): Promise<Response> {
  if (!env.MEDIA) return json({ error: "media storage not configured" }, { status: 501 });
  const owner = await ownerOf(env, cacheId);
  if (!owner) return json({ error: "unknown cache" }, { status: 404 });
  const who = await actor(req, env, req.headers.get("x-owner-call") ?? undefined);
  if (!who || who !== owner) return json({ error: "only the owner may upload media" }, { status: 403 });

  const ct = req.headers.get("content-type") ?? "application/octet-stream";
  if (!/^audio\//.test(ct)) return json({ error: "expected an audio/* body" }, { status: 415 });
  const bytes = new Uint8Array(await req.arrayBuffer());
  if (!bytes.length || bytes.length > 5_000_000) return json({ error: "empty or >5MB" }, { status: 413 });
  const ext = ct.split("/")[1]?.split(";")[0] ?? "bin";
  const key = `cache/${cacheId}/stage/${stageNo}/clue.${ext}`;
  await env.MEDIA.put(key, bytes, ct);
  await env.DB.prepare("UPDATE cache_stages SET media_key=? WHERE cache_id=? AND stage_no=?").bind(key, cacheId, stageNo).run();
  return json({ ok: true, mediaKey: key });
}

// ---- serve a media clue (public; the clue is meant to be heard) ----
export async function handleGetMedia(req: Request, env: Env, key: string): Promise<Response> {
  if (!env.MEDIA) return new Response("media not configured", { status: 501 });
  const obj = await env.MEDIA.get(key);
  if (!obj) return new Response("not found", { status: 404 });
  return new Response(obj.bytes as unknown as BodyInit, { headers: { "content-type": obj.contentType, "cache-control": "public, max-age=86400" } });
}

// ---- list stages (coords hidden unless stage 0 or unlocked by the caller) ----
export async function handleGetStages(req: Request, env: Env, cacheId: number): Promise<Response> {
  const callsign = new URL(req.url).searchParams.get("callsign");
  const rows = (await env.DB.prepare(
    "SELECT stage_no, unlock, clue, media_key, lat, lon, radius_m FROM cache_stages WHERE cache_id=? ORDER BY stage_no",
  ).bind(cacheId).all<StageRow>()).results;
  const unlocked = callsign ? await unlockedSet(env, cacheId, callsign) : new Set<number>();
  return json({
    stages: rows.map((r) => {
      const open = r.stage_no === 0 || unlocked.has(r.stage_no);
      return {
        stageNo: r.stage_no, unlock: r.unlock, clue: r.clue,
        mediaUrl: r.media_key ? `/api/media/${r.media_key}` : null,
        radiusM: r.radius_m, unlocked: open,
        lat: open ? r.lat : null, lon: open ? r.lon : null,
      };
    }),
  });
}

// ---- unlock a stage: reveal its coords once the prerequisite is met ----
export async function handleUnlockStage(req: Request, env: Env, cacheId: number, stageNo: number): Promise<Response> {
  const b = (await req.json().catch(() => ({}))) as { callsign?: string; appGeo?: { lat: number; lon: number } };
  if (!b.callsign) return json({ error: "callsign required" }, { status: 400 });
  const cs = b.callsign.toUpperCase();
  if (stageNo <= 0) return json({ error: "stage 0 is the public start" }, { status: 400 });

  const stage = await env.DB.prepare("SELECT * FROM cache_stages WHERE cache_id=? AND stage_no=?").bind(cacheId, stageNo).first<StageRow>();
  if (!stage) return json({ error: "no such stage" }, { status: 404 });
  const prev = await env.DB.prepare("SELECT * FROM cache_stages WHERE cache_id=? AND stage_no=?").bind(cacheId, stageNo - 1).first<StageRow>();
  if (!prev) return json({ error: "previous stage missing" }, { status: 409 });

  // must have reached the previous stage first
  const unlocked = await unlockedSet(env, cacheId, cs);
  if (stageNo - 1 > 0 && !unlocked.has(stageNo - 1)) return json({ error: "reach the previous stage first", needStage: stageNo - 1 }, { status: 403 });

  // geofence gate: be within the previous stage's radius
  if (stage.unlock === "geo") {
    if (!b.appGeo) return json({ error: "in-app location required to unlock", reason: "no_geo" }, { status: 403 });
    if (prev.lat == null || prev.lon == null) return json({ error: "previous stage has no coordinates" }, { status: 409 });
    const d = haversineMeters(b.appGeo.lat, b.appGeo.lon, prev.lat, prev.lon);
    if (d > prev.radius_m) return json({ unlocked: false, reason: "too_far", distanceM: Math.round(d), radiusM: prev.radius_m }, { status: 403 });
  }
  // 'audio'/'open' unlock on request (the audio clue is an advisory gate)

  await env.DB.prepare("INSERT OR IGNORE INTO stage_unlocks (callsign, cache_id, stage_no, unlocked_at) VALUES (?,?,?,?)").bind(cs, cacheId, stageNo, now()).run();
  return json({ unlocked: true, stageNo, lat: stage.lat, lon: stage.lon, clue: stage.clue, mediaUrl: stage.media_key ? `/api/media/${stage.media_key}` : null });
}

/** Count stages for a cache (so the detail endpoint can flag multi-stage caches). */
export async function stageCount(env: Env, cacheId: number): Promise<number> {
  const r = await env.DB.prepare("SELECT COUNT(*) AS n FROM cache_stages WHERE cache_id=?").bind(cacheId).first<{ n: number }>();
  return r?.n ?? 0;
}
