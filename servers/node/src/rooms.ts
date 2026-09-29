// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Region rooms over the `ws` package: a joined socket adapted to the shared in-memory rooms
 * (@aprscaching/gateway/rooms-core), which hold the subscription, backpressure and liveness logic.
 */
import type { WebSocket } from "ws";
import type { RoomsCore } from "@aprscaching/gateway/rooms-core";

export function joinRoom(rooms: RoomsCore, region: string, ws: WebSocket): void {
  const member = rooms.join(region, {
    send: (text) => {
      ws.send(text);
      return true; // `ws` queues every frame; its backlog shows in bufferedAmount
    },
    bufferedAmount: () => ws.bufferedAmount,
    ping: () => ws.ping(),
    terminate: () => ws.terminate(),
  });
  ws.on("message", (data) => member.message(String(data)));
  ws.on("pong", () => member.pong());
  ws.on("close", () => member.leave());
  ws.on("error", () => member.leave());
}
