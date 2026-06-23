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
import { handleClaim, handlePasskeyVerify } from "./auth.js";
import { startAprsChallenge, confirmAprsChallenge } from "./callsign.js";
import { outboxPending, outboxAck } from "./outbox.js";
import { handleWellKnown, handleFederationCaches, handleFederationFinds } from "./federation.js";

/** OPTIONS preflight + route + reflective CORS. The single entry both runtimes call. */
export async function handle(req: Request, env: Env, ctx: ExecCtx): Promise<Response> {
  if (req.method === "OPTIONS") return withCors(new Response(null, { status: 204 }), req);
  const res = await route(req, env, ctx);
  return withCors(res, req);
}

/** Nightly TTL of firehose positions (logger positions are kept longer for verification). */
export async function runScheduled(env: Env): Promise<void> {
  const cutoff = Math.floor(Date.now() / 1000) - 7 * 24 * 3600;
  await env.DB.prepare("DELETE FROM positions WHERE source = 'firehose' AND ts < ?").bind(cutoff).run();
}

export async function route(req: Request, env: Env, ctx: ExecCtx): Promise<Response> {
  const url = new URL(req.url);
  const p = url.pathname, m = req.method;

  if (p === "/health") return json({ ok: true });

  // federation (F1): discovery + read-only signed feeds for mirroring
  if (p === "/.well-known/aprscaching" && m === "GET") return handleWellKnown(req, env);
  if (p === "/federation/caches" && m === "GET") return handleFederationCaches(req, env);
  if (p === "/federation/finds" && m === "GET") return handleFederationFinds(req, env);

  // ingest <-> worker
  if (p === "/ingest" && m === "POST") return handleIngest(req, env, ctx);
  if (p === "/outbox" && m === "GET") return outboxPending(req, env);
  if (p === "/outbox/ack" && m === "POST") return outboxAck(req, env);

  // live websocket -> region room
  if (p === "/ws") {
    const region = url.searchParams.get("region") ?? "global";
    return env.ROOMS.get(env.ROOMS.idFromName(region)).fetch(req);
  }

  // auth (passkey identity; never blocks logging)
  if (p === "/auth/claim" && m === "POST") return handleClaim(req, env);
  if (p === "/auth/passkey/verify" && m === "POST") return handlePasskeyVerify(req, env);

  // async callsign-control verification badge
  if (p === "/verify/aprs/start" && m === "POST") return startAprsChallenge(req, env);
  if (p === "/verify/aprs/confirm" && m === "POST") return confirmAprsChallenge(req, env);

  // caching REST
  if (p === "/api/caches" && m === "GET") return handleCachesInBBox(req, env);
  if (p === "/api/caches" && m === "POST") return handleCreateCache(req, env);

  // /api/caches/:id  and  /api/caches/:id/logs
  const cacheMatch = /^\/api\/caches\/(\d+)(\/logs)?$/.exec(p);
  if (cacheMatch) {
    const id = Number(cacheMatch[1]);
    const isLogs = cacheMatch[2] === "/logs";
    if (isLogs && m === "POST") return handleLog(req, env, id);
    if (!isLogs && m === "GET") return handleCacheDetail(req, env, id);
    if (!isLogs && (m === "PATCH" || m === "PUT")) return handleUpdateCache(req, env, id);
    return new Response("method not allowed", { status: 405 });
  }

  // generalized + back-compat logging (cacheId in body)
  if ((p === "/api/logs" || p === "/api/logs/find") && m === "POST") return handleLog(req, env);

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
