/**
 * In-memory region rooms — the Node analogue of the RegionRoom Durable Object. No hibernation
 * (a self-host process is always up), but the same subscribe/broadcast fan-out so the live layer
 * (M2 geofence prompts) works off-Cloudflare too.
 */
import type { WebSocket } from "ws";
import { Subscribe } from "@aprsweb/shared";

export class Rooms {
  private rooms = new Map<string, Set<WebSocket>>();

  join(region: string, ws: WebSocket): void {
    let set = this.rooms.get(region);
    if (!set) { set = new Set(); this.rooms.set(region, set); }
    set.add(ws);

    ws.on("message", (data) => {
      try {
        const parsed = Subscribe.safeParse(JSON.parse(String(data)));
        if (parsed.success) (ws as unknown as { __sub?: unknown }).__sub = parsed.data;
      } catch { /* ignore malformed */ }
    });
    const drop = () => set!.delete(ws);
    ws.on("close", drop);
    ws.on("error", drop);
  }

  /** Fan a payload out to every socket subscribed to a region. */
  broadcast(region: string, payload: unknown): void {
    const set = this.rooms.get(region);
    if (!set) return;
    const text = JSON.stringify(payload);
    for (const ws of set) { try { ws.send(text); } catch { /* dropped */ } }
  }

  count(region = "global"): number { return this.rooms.get(region)?.size ?? 0; }
}
