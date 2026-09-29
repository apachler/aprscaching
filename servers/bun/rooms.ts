// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Region rooms over Bun.serve's native WebSocket: a joined socket adapted to the shared in-memory rooms
 * (@aprscaching/gateway/rooms-core), which hold the subscription, backpressure and liveness logic.
 * Bun.serve reports a socket's traffic through its `websocket` handlers ({@link roomHandlers}).
 */
import type { ServerWebSocket, WebSocketHandler } from "bun";
import type { RoomsCore, RoomMember } from "@aprscaching/gateway/rooms-core";

export type WsData = { region: string; member?: RoomMember };

/** Bun.serve `websocket` handlers that keep `rooms` in step with each socket. */
export function roomHandlers(rooms: RoomsCore): WebSocketHandler<WsData> {
  return {
    open(ws: ServerWebSocket<WsData>) {
      ws.data.member = rooms.join(ws.data.region, {
        send: (text) => ws.send(text) !== -1, // -1: Bun dropped the frame under backpressure
        bufferedAmount: () => ws.getBufferedAmount(),
        ping: () => void ws.ping(),
        terminate: () => ws.terminate(),
      });
    },
    message(ws, msg) {
      ws.data.member?.message(String(msg));
    },
    pong(ws) {
      ws.data.member?.pong();
    },
    close(ws) {
      ws.data.member?.leave();
    },
  };
}
