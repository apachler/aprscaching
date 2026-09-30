// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Env } from "./env.js";
import { Subscribe } from "@aprscaching/shared";
import { deliveriesFor, type LiveEnvelope } from "./live.js";
import { BudgetCounter, serveRoom, type BudgetState } from "./budget.js";

/** Storage key of the daily D1 write budget's counter (budget.ts). */
const BUDGET_KEY = "d1-write-budget";

/**
 * RegionRoom — one Durable Object per geographic region.
 * Holds client WebSockets via the Hibernation API (idle => no duration charge) and fans out
 * station deltas + geofence prompts. SQLite-backed => available on Workers Free.
 *
 * The global room also keeps the daily D1 write budget's counter (budget.ts): the ingest hands it each
 * batch's written rows with the live dispatch it already sends, so counting costs no extra request. The
 * counter's storage is this object's own, billed apart from D1, and written at most about once a minute.
 */
export class RegionRoom {
  private counter?: BudgetCounter;

  constructor(
    private ctx: DurableObjectState,
    private env: Env,
  ) {}

  private budget(): BudgetCounter {
    const storage = this.ctx.storage;
    return (this.counter ??= new BudgetCounter({
      load: () => storage.get<BudgetState>(BUDGET_KEY),
      save: (s) => storage.put(BUDGET_KEY, s),
    }));
  }

  async fetch(req: Request): Promise<Response> {
    if (req.headers.get("Upgrade") === "websocket") {
      const pair = new WebSocketPair();
      const [client, server] = [pair[0], pair[1]];
      // Hibernation API: do NOT use server.accept()
      this.ctx.acceptWebSocket(server);
      return new Response(null, { status: 101, webSocket: client });
    }

    // the gateway's own requests: live dispatch from /ingest (each envelope to its matching subscribers)
    // and the write budget
    return serveRoom(
      req,
      (envelopes) => {
        for (const ws of this.ctx.getWebSockets()) {
          const sub = ws.deserializeAttachment() as Subscribe | undefined;
          for (const env of envelopes as LiveEnvelope[]) {
            for (const msg of deliveriesFor(sub, env)) {
              try {
                ws.send(JSON.stringify(msg));
              } catch {
                /* dropped */
              }
            }
          }
        }
      },
      () => this.budget(),
    );
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
