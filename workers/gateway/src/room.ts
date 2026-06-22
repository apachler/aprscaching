import type { Env } from "./env.js";
import { Subscribe } from "@aprsweb/shared";

/**
 * RegionRoom — one Durable Object per geographic region.
 * Holds client WebSockets via the Hibernation API (idle => no duration charge) and
 * fans out station deltas + geofence prompts. SQLite-backed => available on Workers Free.
 */
export class RegionRoom {
  constructor(private ctx: DurableObjectState, private env: Env) {}

  async fetch(req: Request): Promise<Response> {
    if (req.headers.get("Upgrade") !== "websocket")
      return new Response("expected websocket", { status: 426 });
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    // Hibernation API: do NOT use server.accept()
    this.ctx.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, msg: string): Promise<void> {
    const parsed = Subscribe.safeParse(JSON.parse(msg));
    if (parsed.success) {
      // persist per-connection subscription so it survives hibernation
      ws.serializeAttachment(parsed.data);
    }
  }

  /** Called (via RPC, M2) to push a delta/geofence prompt to matching subscribers. */
  broadcast(payload: unknown): void {
    const text = JSON.stringify(payload);
    for (const ws of this.ctx.getWebSockets()) {
      try { ws.send(text); } catch { /* dropped */ }
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> { try { ws.close(); } catch {} }
}
