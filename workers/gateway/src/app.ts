/**
 * Runtime-neutral request handling: routing, CORS, JSON helper, and the scheduled job.
 * Imported by index.ts (Cloudflare Worker) and by the portable Node server — so both runtimes
 * serve byte-identical behaviour. This module never touches Workers-only globals.
 */
import type { Env } from "./env.js";
import type { ExecCtx } from "./runtime.js";
import { handleIngest } from "./ingest.js";
import {
  handleLog, handleCachesInBBox, handleCreateCache, handleCacheDetail, handleUpdateCache,
} from "./caches.js";
import { handleClaim, handleSession, handleLogout, handleChangeCallsign,
  handlePasskeyRegisterBegin, handlePasskeyRegisterFinish, handlePasskeyLoginBegin, handlePasskeyLoginFinish } from "./auth.js";
import { handleEmailStart, handleEmailVerify } from "./email.js";
import { startAprsChallenge, confirmAprsChallenge, aprsVerifyStatus } from "./callsign.js";
import { outboxPending, outboxAck } from "./outbox.js";
import { handleWellKnown, handleFederationCaches, handleFederationFinds, handleFederationKeys } from "./federation.js";
import { handleFederationSync, handleFederationPeers, syncAllPeers } from "./federation_sync.js";
import { handleCorroborate } from "./corroborate.js";
import { handleRegisterKey, handleGetKeys } from "./keys.js";
import { handleImport } from "./import/engine.js";
import { handleLeaderboard, handleProfile, handleActivity, handleFavorite, handleWatch } from "./community.js";
import { handleDecode, handleStations, handleStation, handlePorts, handleMessages } from "./workbench.js";
import { handleCot } from "./cot.js";
import { handleBadge } from "./badge.js";
import { handleSetStages, handleGetStages, handleUnlockStage, handleStageMedia, handleGetMedia } from "./stages.js";
import { handleAccountExport, handleAccountDelete, handleAccountBundle, handleAccountMove, handleAccountImport } from "./account.js";
import { handleBbsPost, handleBbsList, handleBbsBulletins, handleBbsRead } from "./bbs.js";
export { syncAllPeers } from "./federation_sync.js";

/** OPTIONS preflight + route + reflective CORS. The single entry both runtimes call. */
export async function handle(req: Request, env: Env, ctx: ExecCtx): Promise<Response> {
  if (req.method === "OPTIONS") return withCors(new Response(null, { status: 204 }), req);
  const res = await route(req, env, ctx);
  return withCors(res, req);
}

/** Scheduled work: TTL firehose positions (loggers kept longer) + pull from federation peers. */
export async function runScheduled(env: Env): Promise<void> {
  const cutoff = Math.floor(Date.now() / 1000) - 7 * 24 * 3600;
  await env.DB.prepare("DELETE FROM positions WHERE source = 'firehose' AND ts < ?").bind(cutoff).run();
  try { await syncAllPeers(env); } catch (e) { console.error("federation sync:", (e as Error).message); }
}

export async function route(req: Request, env: Env, ctx: ExecCtx): Promise<Response> {
  const url = new URL(req.url);
  const p = url.pathname, m = req.method;

  if (p === "/health") return json({ ok: true });

  // embeddable network badge (QRZ.com / signatures): /badge/OE8APR.svg
  const badgeMatch = /^\/badge\/([A-Za-z0-9-]+)\.svg$/.exec(p);
  if (badgeMatch && m === "GET") return handleBadge(req, env, badgeMatch[1]!);

  // federation (F1): discovery + read-only signed feeds for mirroring
  if (p === "/.well-known/aprscaching" && m === "GET") return handleWellKnown(req, env);
  if (p === "/federation/caches" && m === "GET") return handleFederationCaches(req, env);
  if (p === "/federation/finds" && m === "GET") return handleFederationFinds(req, env);
  if (p === "/federation/peers" && m === "GET") return handleFederationPeers(req, env);
  if (p === "/federation/sync" && m === "POST") return handleFederationSync(req, env);
  if (p === "/federation/corroborate" && m === "POST") return handleCorroborate(req, env);
  if (p === "/federation/keys" && m === "GET") return handleFederationKeys(req, env);

  // account data lifecycle (GDPR export/erasure + portability across peers)
  if (p === "/api/account/import" && m === "POST") return handleAccountImport(req, env);
  const acctMatch = /^\/api\/account\/([A-Za-z0-9-]+)\/(export|delete|bundle|move)$/.exec(p);
  if (acctMatch && m === "POST") {
    const [cs, op] = [acctMatch[1]!, acctMatch[2]!];
    if (op === "export") return handleAccountExport(req, env, cs);
    if (op === "delete") return handleAccountDelete(req, env, cs);
    if (op === "bundle") return handleAccountBundle(req, env, cs);
    if (op === "move") return handleAccountMove(req, env, cs);
  }

  // per-callsign device keys (F0)
  if (p === "/keys/register" && m === "POST") return handleRegisterKey(req, env);
  const keyMatch = /^\/keys\/([A-Za-z0-9-]+)$/.exec(p);
  if (keyMatch && m === "GET" && keyMatch[1] !== "register") return handleGetKeys(req, env, keyMatch[1]!);

  // ingest <-> worker
  if (p === "/ingest" && m === "POST") return handleIngest(req, env, ctx);
  if (p === "/outbox" && m === "GET") return outboxPending(req, env);
  if (p === "/outbox/ack" && m === "POST") return outboxAck(req, env);

  // live websocket -> region room
  if (p === "/ws") {
    const region = url.searchParams.get("region") ?? "global";
    return env.ROOMS.get(env.ROOMS.idFromName(region)).fetch(req);
  }

  // auth (M9 identity: passkey + email magic-link). Sessions attribute logs once gating lands.
  if (p === "/auth/claim" && m === "POST") return handleClaim(req, env);
  if (p === "/auth/passkey/register/begin" && m === "POST") return handlePasskeyRegisterBegin(req, env);
  if (p === "/auth/passkey/register/finish" && m === "POST") return handlePasskeyRegisterFinish(req, env);
  if (p === "/auth/passkey/login/begin" && m === "POST") return handlePasskeyLoginBegin(req, env);
  if (p === "/auth/passkey/login/finish" && m === "POST") return handlePasskeyLoginFinish(req, env);
  if (p === "/auth/email/start" && m === "POST") return handleEmailStart(req, env);
  if (p === "/auth/email/verify" && (m === "POST" || m === "GET")) return handleEmailVerify(req, env);
  if (p === "/auth/session" && m === "GET") return handleSession(req, env);
  if (p === "/auth/callsign" && m === "POST") return handleChangeCallsign(req, env);
  if (p === "/auth/logout" && m === "POST") return handleLogout();

  // async callsign-control verification badge
  if (p === "/verify/aprs/start" && m === "POST") return startAprsChallenge(req, env);
  if (p === "/verify/aprs/confirm" && m === "POST") return confirmAprsChallenge(req, env);
  if (p === "/verify/aprs/status" && m === "GET") return aprsVerifyStatus(req, env);

  // caching REST
  if (p === "/api/caches" && m === "GET") return handleCachesInBBox(req, env);
  if (p === "/api/caches" && m === "POST") return handleCreateCache(req, env);

  // community / gamification (M4)
  if (p === "/api/leaderboard" && m === "GET") return handleLeaderboard(req, env);
  if (p === "/api/activity" && m === "GET") return handleActivity(req, env);
  const profileMatch = /^\/api\/profile\/([A-Za-z0-9-]+)$/.exec(p);
  if (profileMatch && m === "GET") return handleProfile(req, env, profileMatch[1]!);

  // workbench (M5): packet inspector + live station registry
  if (p === "/api/decode" && m === "POST") return handleDecode(req);
  if (p === "/api/stations" && m === "GET") return handleStations(req, env);
  const stationMatch = /^\/api\/stations\/([A-Za-z0-9-]+)$/.exec(p);
  if (stationMatch && m === "GET") return handleStation(req, env, stationMatch[1]!);

  // BBS store-and-forward (messages + bulletins)
  if (p === "/api/bbs/messages" && m === "POST") return handleBbsPost(req, env);
  if (p === "/api/bbs/messages" && m === "GET") return handleBbsList(req, env);
  if (p === "/api/bbs/bulletins" && m === "GET") return handleBbsBulletins(req, env);
  const bbsReadMatch = /^\/api\/bbs\/messages\/(\d+)\/read$/.exec(p);
  if (bbsReadMatch && m === "POST") return handleBbsRead(req, env, Number(bbsReadMatch[1]));

  // workbench interop + transports (M6)
  if (p === "/api/cot" && m === "GET") return handleCot(req, env, Math.floor(Date.now() / 1000));
  if (p === "/api/ports" && m === "GET") return handlePorts(req, env);
  if (p === "/api/messages" && m === "GET") return handleMessages(req, env);

  // audio-cache: stages + media (M2)
  if (p.startsWith("/api/media/") && m === "GET") return handleGetMedia(req, env, p.slice("/api/media/".length));
  const stagesMatch = /^\/api\/caches\/(\d+)\/stages$/.exec(p);
  if (stagesMatch) {
    const id = Number(stagesMatch[1]);
    if (m === "GET") return handleGetStages(req, env, id);
    if (m === "POST") return handleSetStages(req, env, id);
  }
  const stageOpMatch = /^\/api\/caches\/(\d+)\/stages\/(\d+)\/(unlock|media)$/.exec(p);
  if (stageOpMatch) {
    const id = Number(stageOpMatch[1]), n = Number(stageOpMatch[2]);
    if (stageOpMatch[3] === "unlock" && m === "POST") return handleUnlockStage(req, env, id, n);
    if (stageOpMatch[3] === "media" && m === "PUT") return handleStageMedia(req, env, id, n);
  }

  // /api/caches/:id  and  /api/caches/:id/{logs,favorite,watch}
  const cacheMatch = /^\/api\/caches\/(\d+)(\/logs|\/favorite|\/watch)?$/.exec(p);
  if (cacheMatch) {
    const id = Number(cacheMatch[1]);
    const sub = cacheMatch[2];
    if (sub === "/logs" && m === "POST") return handleLog(req, env, id);
    if (sub === "/favorite" && m === "POST") return handleFavorite(req, env, id);
    if (sub === "/watch" && m === "POST") return handleWatch(req, env, id);
    if (!sub && m === "GET") return handleCacheDetail(req, env, id);
    if (!sub && (m === "PATCH" || m === "PUT")) return handleUpdateCache(req, env, id);
    return new Response("method not allowed", { status: 405 });
  }

  // generalized + back-compat logging (cacheId in body)
  if ((p === "/api/logs" || p === "/api/logs/find") && m === "POST") return handleLog(req, env);

  // M3 import: POST /api/import/:source (admin)
  const importMatch = /^\/api\/import\/([a-z]+)$/.exec(p);
  if (importMatch && m === "POST") return handleImport(req, env, importMatch[1]!);

  return new Response("not found", { status: 404 });
}

export function json(data: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(data), {
    ...init, headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

/** Permissive CORS that reflects the request origin so the SPA (different origin) can call the API. */
export function withCors(res: Response, req: Request): Response {
  const origin = req.headers.get("Origin");
  if (!origin) return res;
  const h = new Headers(res.headers);
  h.set("Access-Control-Allow-Origin", origin);
  h.set("Vary", "Origin");
  h.set("Access-Control-Allow-Credentials", "true");
  h.set("Access-Control-Allow-Methods", "GET,POST,PATCH,PUT,DELETE,OPTIONS");
  h.set("Access-Control-Allow-Headers", req.headers.get("Access-Control-Request-Headers") ?? "content-type");
  h.set("Access-Control-Max-Age", "86400");
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
}
