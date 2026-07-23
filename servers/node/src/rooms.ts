// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * In-memory region rooms — the Node analogue of the RegionRoom Durable Object. No hibernation
 * (a self-host process is always up), but the same subscribe/broadcast fan-out so the live layer
 * (geofence prompts) works off-Cloudflare too.
 */
import type { WebSocket } from "ws";
import { Subscribe } from "@aprscaching/shared";
import { deliveriesFor, type LiveEnvelope } from "@aprscaching/gateway/live";

// A half-open client (phone that lost coverage) keeps its TCP socket up but never reads.
// Without a liveness sweep it lingers in the Set forever, and without a backpressure cap the region
// firehose buffers into its send queue until the process OOMs.
const HEARTBEAT_MS = 30_000;
const MAX_BUFFERED = 1 << 20; // 1 MiB queued to one client ⇒ it's not draining ⇒ drop it

type Tracked = WebSocket & { __sub?: Subscribe; __alive?: boolean };

export class Rooms {
  private rooms = new Map<string, Set<WebSocket>>();

  constructor() {
    const t = setInterval(() => this.heartbeat(), HEARTBEAT_MS);
    (t as unknown as { unref?: () => void }).unref?.(); // don't keep the process alive for the sweep
  }

  private heartbeat(): void {
    for (const set of this.rooms.values()) {
      for (const ws of set) {
        const w = ws as Tracked;
        if (w.__alive === false) {
          try {
            w.terminate();
          } catch {
            /* noop */
          }
          set.delete(ws);
          continue;
        }
        w.__alive = false;
        try {
          w.ping();
        } catch {
          set.delete(ws);
        }
      }
    }
  }

  join(region: string, ws: WebSocket): void {
    let set = this.rooms.get(region);
    if (!set) {
      set = new Set();
      this.rooms.set(region, set);
    }
    set.add(ws);
    const w = ws as Tracked;
    w.__alive = true;
    ws.on("pong", () => {
      w.__alive = true;
    });

    ws.on("message", (data) => {
      try {
        const parsed = Subscribe.safeParse(JSON.parse(String(data)));
        if (parsed.success) w.__sub = parsed.data;
      } catch {
        /* ignore malformed */
      }
    });
    const drop = () => set!.delete(ws);
    ws.on("close", drop);
    ws.on("error", drop);
  }

  /** Deliver live envelopes to each subscriber per their subscription (same semantics as the DO). */
  dispatch(region: string, envelopes: LiveEnvelope[]): void {
    const set = this.rooms.get(region);
    if (!set) return;
    for (const ws of set) {
      // backpressure: a client whose send queue is backing up isn't reading — drop it rather than OOM.
      if (ws.bufferedAmount > MAX_BUFFERED) {
        try {
          (ws as Tracked).terminate();
        } catch {
          /* noop */
        }
        set.delete(ws);
        continue;
      }
      const sub = (ws as Tracked).__sub;
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
  }

  count(region = "global"): number {
    return this.rooms.get(region)?.size ?? 0;
  }
}
