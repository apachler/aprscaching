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
  constructor(
    private ctx: DurableObjectState,
    private env: Env,
  ) {}

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
            try {
              ws.send(JSON.stringify(msg));
            } catch {
              /* dropped */
            }
          }
        }
      }
      return new Response(null, { status: 204 });
    }
    return new Response("expected websocket", { status: 426 });
  }

  async webSocketMessage(ws: WebSocket, msg: string | ArrayBuffer): Promise<void> {
    // A hostile/buggy client can send non-JSON or a binary frame — neither must crash the DO.
    try {
      const text = typeof msg === "string" ? msg : new TextDecoder().decode(msg);
      const parsed = Subscribe.safeParse(JSON.parse(text));
      if (parsed.success) ws.serializeAttachment(parsed.data); // survives hibernation
    } catch {
      /* ignore junk frames */
    }
  }

  async webSocketClose(ws: WebSocket, code?: number, reason?: string): Promise<void> {
    // Echo a valid close code (1000 when the client sent a reserved/absent one).
    try {
      ws.close(code && code >= 1000 && code < 5000 ? code : 1000, reason);
    } catch {
      /* already closing */
    }
  }
  async webSocketError(ws: WebSocket): Promise<void> {
    try {
      ws.close(1011, "error");
    } catch {
      /* noop */
    }
  }
}
