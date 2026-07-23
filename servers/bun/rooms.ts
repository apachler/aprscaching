// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * In-memory region rooms over Bun.serve's native WebSocket (Bun analogue of servers/node/rooms.ts,
 * which uses the `ws` package). Same subscribe/broadcast fan-out so the geofence live layer works
 * under Bun too.
 */
import type { ServerWebSocket } from "bun";
import { Subscribe } from "@aprscaching/shared";
import { deliveriesFor, type LiveEnvelope } from "@aprscaching/gateway/live";

// A half-open client (phone that lost coverage) keeps its TCP socket up but never reads. Without a
// liveness sweep it lingers in the Set forever; the backpressure guard in dispatch() then stops
// buffering to it, but only the ping/pong sweep actually reaps it. Mirrors servers/node/rooms.ts.
const HEARTBEAT_MS = 30_000;

export type WsData = { region: string; sub?: Subscribe; alive?: boolean };

export class BunRooms {
  private rooms = new Map<string, Set<ServerWebSocket<WsData>>>();

  constructor() {
    const t = setInterval(() => this.heartbeat(), HEARTBEAT_MS);
    (t as unknown as { unref?: () => void }).unref?.(); // don't keep the process alive for the sweep
  }

  private heartbeat(): void {
    for (const set of this.rooms.values()) {
      for (const ws of set) {
        if (ws.data.alive === false) {
          try {
            ws.terminate();
          } catch {
            /* noop */
          }
          set.delete(ws);
          continue;
        }
        ws.data.alive = false;
        try {
          ws.ping();
        } catch {
          set.delete(ws); // socket closing/closed — drop it
        }
      }
    }
  }

  join(ws: ServerWebSocket<WsData>): void {
    const r = ws.data.region;
    let set = this.rooms.get(r);
    if (!set) {
      set = new Set();
      this.rooms.set(r, set);
    }
    set.add(ws);
    ws.data.alive = true;
  }
  leave(ws: ServerWebSocket<WsData>): void {
    this.rooms.get(ws.data.region)?.delete(ws);
  }
  /** A pong (or any client frame) proves the socket is still reading — keep it alive past the sweep. */
  onPong(ws: ServerWebSocket<WsData>): void {
    ws.data.alive = true;
  }
  onMessage(ws: ServerWebSocket<WsData>, raw: string | Buffer): void {
    ws.data.alive = true;
    try {
      const parsed = Subscribe.safeParse(JSON.parse(String(raw)));
      if (parsed.success) ws.data.sub = parsed.data;
    } catch {
      /* ignore malformed */
    }
  }

  count(region = "global"): number {
    return this.rooms.get(region)?.size ?? 0;
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
