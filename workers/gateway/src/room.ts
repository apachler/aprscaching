// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Env } from "./env.js";
import { Subscribe } from "@aprsweb/shared";
import { deliveriesFor, type LiveEnvelope } from "./live.js";

/**
 * RegionRoom — one Durable Object per geographic region.
 * Holds client WebSockets via the Hibernation API (idle => no duration charge) and fans out
 * station deltas + geofence prompts. SQLite-backed => available on Workers Free.
 */
export class RegionRoom {
  constructor(private ctx: DurableObjectState, private env: Env) {}

  async fetch(req: Request): Promise<Response> {
    if (req.headers.get("Upgrade") === "websocket") {
      const pair = new WebSocketPair();
      const [client, server] = [pair[0], pair[1]];
      // Hibernation API: do NOT use server.accept()
      this.ctx.acceptWebSocket(server);
      return new Response(null, { status: 101, webSocket: client });
    }

    // live dispatch from /ingest: deliver each envelope to matching subscribers
    if (req.method === "POST") {
      const { envelopes } = (await req.json()) as { envelopes: LiveEnvelope[] };
      for (const ws of this.ctx.getWebSockets()) {
        const sub = ws.deserializeAttachment() as Subscribe | undefined;
        for (const env of envelopes) {
          for (const msg of deliveriesFor(sub, env)) {
            try { ws.send(JSON.stringify(msg)); } catch { /* dropped */ }
          }
        }
      }
      return new Response(null, { status: 204 });
    }
    return new Response("expected websocket", { status: 426 });
  }

  async webSocketMessage(ws: WebSocket, msg: string): Promise<void> {
    const parsed = Subscribe.safeParse(JSON.parse(msg));
    // persist per-connection subscription so it survives hibernation
    if (parsed.success) ws.serializeAttachment(parsed.data);
  }

  async webSocketClose(ws: WebSocket): Promise<void> { try { ws.close(); } catch {} }
}
