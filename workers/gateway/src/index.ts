import type { Env } from "./env.js";
import { handleIngest } from "./ingest.js";
import { handleLogFind, handleCachesInBBox } from "./caches.js";
import { handleClaim, handlePasskeyVerify } from "./auth.js";
import { startAprsChallenge, confirmAprsChallenge } from "./callsign.js";
import { outboxPending, outboxAck } from "./outbox.js";
export { RegionRoom } from "./room.js";

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const p = url.pathname, m = req.method;

    if (p === "/health") return json({ ok: true });

    // ingest <-> worker
    if (p === "/ingest" && m === "POST") return handleIngest(req, env, ctx);
    if (p === "/outbox" && m === "GET") return outboxPending(req, env);
    if (p === "/outbox/ack" && m === "POST") return outboxAck(req, env);

    // live websocket -> region Durable Object
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
    if (p === "/api/logs/find" && m === "POST") return handleLogFind(req, env);

    return new Response("not found", { status: 404 });
  },

  async scheduled(_e: ScheduledController, env: Env): Promise<void> {
    const cutoff = Math.floor(Date.now() / 1000) - 7 * 24 * 3600;
    await env.DB.prepare("DELETE FROM positions WHERE source = 'firehose' AND ts < ?").bind(cutoff).run();
  },
};

export function json(data: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(data), {
    ...init, headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
}
