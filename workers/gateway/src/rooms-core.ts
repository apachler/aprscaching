// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * In-memory region rooms for the self-host runtimes — the Node and Bun analogue of the RegionRoom
 * Durable Object. No hibernation (a self-host process is always up), but the same subscribe/broadcast
 * fan-out, so the live layer (station deltas, geofence prompts) works off Cloudflare too. Delivery
 * follows `deliveriesFor`, exactly as the Durable Object does.
 *
 * Runtime-neutral: each runtime adapts its WebSocket to {@link RoomSocket} (servers/node over `ws`,
 * servers/bun over Bun.serve) and forwards the socket's messages, pongs and close to the member.
 *
 * A half-open client (a phone that lost coverage) keeps its TCP socket up but never reads. The
 * ping/pong sweep reaps it, and a client whose send queue backs up is dropped before its buffer can
 * exhaust the process.
 *
 * The rooms also hold the daily write budget's counter (budget.ts), in memory: the guard is opt-in on a
 * self-host runtime, and a restart starts the day's count again from zero.
 */
import { Subscribe } from "@aprscaching/shared";
import { deliveriesFor, type LiveEnvelope } from "./live.js";
import { BudgetCounter, memoryBudgetStore } from "./budget.js";

const HEARTBEAT_MS = 30_000;
/** Bytes queued to one client past which it is not draining and is dropped. */
const MAX_BUFFERED = 1 << 20;

/** The four things the rooms need from a runtime's WebSocket. */
export interface RoomSocket {
  /** Queue a text frame; false when the runtime refused it under backpressure. */
  send(text: string): boolean;
  /** Bytes queued to this client and not yet written. */
  bufferedAmount(): number;
  ping(): void;
  terminate(): void;
}

/** One joined socket: the runtime reports its traffic here. */
export interface RoomMember {
  /** A client frame: a subscription, and proof the socket is reading. */
  message(raw: string): void;
  /** A pong: the socket is still reading. */
  pong(): void;
  /** The socket closed or errored. */
  leave(): void;
}

interface State {
  sub?: Subscribe;
  alive: boolean;
}

export class RoomsCore {
  private rooms = new Map<string, Map<RoomSocket, State>>();
  /** The daily D1 write budget's counter, as the Durable Object keeps it on Cloudflare. */
  readonly budgetCounter = new BudgetCounter(memoryBudgetStore());

  /** `heartbeatMs: 0` runs no timer (the caller sweeps). */
  constructor(opts: { heartbeatMs?: number } = {}) {
    const every = opts.heartbeatMs ?? HEARTBEAT_MS;
    if (every > 0) {
      const t = setInterval(() => this.sweep(), every);
      (t as unknown as { unref?: () => void }).unref?.(); // the sweep never keeps the process alive
    }
  }

  join(region: string, socket: RoomSocket): RoomMember {
    let room = this.rooms.get(region);
    if (!room) this.rooms.set(region, (room = new Map()));
    const state: State = { alive: true };
    room.set(socket, state);
    const members = room;
    return {
      message(raw) {
        state.alive = true;
        try {
          const parsed = Subscribe.safeParse(JSON.parse(raw));
          if (parsed.success) state.sub = parsed.data;
        } catch {
          /* ignore malformed */
        }
      },
      pong() {
        state.alive = true;
      },
      leave() {
        members.delete(socket);
      },
    };
  }

  /** Terminate every member that has not answered since the last sweep, and ping the rest. */
  sweep(): void {
    for (const room of this.rooms.values())
      for (const [socket, state] of room) {
        if (!state.alive) {
          drop(room, socket);
          continue;
        }
        state.alive = false;
        try {
          socket.ping();
        } catch {
          room.delete(socket); // closing or closed
        }
      }
  }

  /** Deliver live envelopes to each member per its subscription (the Durable Object's semantics). */
  dispatch(region: string, envelopes: LiveEnvelope[]): void {
    const room = this.rooms.get(region);
    if (!room) return;
    for (const [socket, state] of room) {
      if (socket.bufferedAmount() > MAX_BUFFERED) {
        drop(room, socket);
        continue;
      }
      // once the runtime refuses a frame, stop piling more onto this socket for this dispatch; the
      // client catches up from its next poll
      send: for (const env of envelopes)
        for (const msg of deliveriesFor(state.sub, env)) {
          let ok: boolean;
          try {
            ok = socket.send(JSON.stringify(msg));
          } catch {
            ok = false; // closing or closed
          }
          if (!ok) break send;
        }
    }
  }

  count(region = "global"): number {
    return this.rooms.get(region)?.size ?? 0;
  }
}

function drop(room: Map<RoomSocket, State>, socket: RoomSocket): void {
  try {
    socket.terminate();
  } catch {
    /* already gone */
  }
  room.delete(socket);
}
