// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * In-memory region rooms over Bun.serve's native WebSocket (Bun analogue of servers/node/rooms.ts,
 * which uses the `ws` package). Same subscribe/broadcast fan-out so the geofence live layer works
 * under Bun too.
 */
import type { ServerWebSocket } from "bun";
import { Subscribe } from "@aprsweb/shared";
import { deliveriesFor, type LiveEnvelope } from "@aprsweb/gateway/live";

export type WsData = { region: string; sub?: Subscribe };

export class BunRooms {
  private rooms = new Map<string, Set<ServerWebSocket<WsData>>>();

  join(ws: ServerWebSocket<WsData>): void {
    const r = ws.data.region;
    let set = this.rooms.get(r);
    if (!set) {
      set = new Set();
      this.rooms.set(r, set);
    }
    set.add(ws);
  }
  leave(ws: ServerWebSocket<WsData>): void {
    this.rooms.get(ws.data.region)?.delete(ws);
  }
  onMessage(ws: ServerWebSocket<WsData>, raw: string | Buffer): void {
    try {
      const parsed = Subscribe.safeParse(JSON.parse(String(raw)));
      if (parsed.success) ws.data.sub = parsed.data;
    } catch {
      /* ignore malformed */
    }
  }

  /** Deliver live envelopes to each subscriber per its subscription (same semantics as the DO). */
  dispatch(region: string, envelopes: LiveEnvelope[]): void {
    const set = this.rooms.get(region);
    if (!set) return;
    for (const ws of set) {
      // Bun's send() returns -1 when the message was dropped under backpressure (a slow or
      // stalled consumer). Once that happens, stop piling more frames onto the same socket this
      // dispatch — continuing just grows the backpressure buffer; the consumer resyncs on its next poll.
      let backpressured = false;
      for (const env of envelopes) {
        if (backpressured) break;
        for (const msg of deliveriesFor(ws.data.sub, env)) {
          try {
            if (ws.send(JSON.stringify(msg)) === -1) {
              backpressured = true;
              break;
            }
          } catch {
            backpressured = true; // socket closing/closed — stop sending to it
            break;
          }
        }
      }
    }
  }
}
