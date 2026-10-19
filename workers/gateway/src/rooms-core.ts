// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * In-memory region rooms for the live layer (station deltas, geofence prompts) on Node and Bun: each
 * client subscribes, and every envelope the ingest dispatches is delivered per `deliveriesFor`.
 *
 * Runtime-neutral: each runtime adapts its WebSocket to {@link RoomSocket} (servers/node over `ws`,
 * servers/bun over Bun.serve) and forwards the socket's messages, pongs and close to the member.
 *
 * A half-open client (a phone that lost coverage) keeps its TCP socket up but never reads. The
 * ping/pong sweep reaps it, and a client whose send queue backs up is dropped before its buffer can
 * exhaust the process.
 *
 * Beside the sockets, a region takes in-process listeners ({@link RoomsCore.listen}): the read API's heard
 * stream (heardfeed.ts) sees every dispatch the live map sees, from the same memory, with no database read.
 */
import { Subscribe } from "@aprscaching/shared";
import { deliveriesFor, liveRegionOf, type LiveEnvelope } from "./live.js";

const HEARTBEAT_MS = 30_000;
/** Bytes queued to one client past which it is not draining and is dropped. */
const MAX_BUFFERED = 1 << 20;

/**
 * The largest frame a client may send. A subscription is a few hundred bytes, and a runtime buffers a whole
 * message before handing it over, so a larger one closes the socket instead of being held in memory.
 */
export const LIVE_MESSAGE_MAX_BYTES = 4096;
/**
 * Live sockets one client address holds open at once: room for a few tabs and devices behind one address.
 * The upgrade needs no sign-in, so without a bound one client could open sockets until the process runs out.
 */
export const LIVE_SOCKETS_PER_CLIENT = 16;

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
  /** The client address the socket was opened from (clientIp). */
  holder: string;
}

/** An in-process listener on a region's dispatches, and who holds it (an API key or a client address). */
interface Listener {
  holder: string;
  fn: (envelopes: LiveEnvelope[]) => void;
}

export class RoomsCore {
  private rooms = new Map<string, Map<RoomSocket, State>>();
  private listeners = new Map<string, Set<Listener>>();

  /** `heartbeatMs: 0` runs no timer (the caller sweeps). */
  constructor(opts: { heartbeatMs?: number } = {}) {
    const every = opts.heartbeatMs ?? HEARTBEAT_MS;
    if (every > 0) {
      const t = setInterval(() => this.sweep(), every);
      (t as unknown as { unref?: () => void }).unref?.(); // the sweep never keeps the process alive
    }
  }

  /**
   * Whether `holder` (the client address, clientIp) may open a live socket for the upgrade `url`: the room's
   * region, or the status and reason the runtime refuses the upgrade with.
   */
  admit(url: URL, holder: string): { region: string } | { status: 400 | 429; error: string } {
    const region = liveRegionOf(url);
    if (!region) return { status: 400, error: "unknown region" };
    let held = 0;
    for (const room of this.rooms.values()) for (const state of room.values()) if (state.holder === holder) held++;
    if (held >= LIVE_SOCKETS_PER_CLIENT)
      return { status: 429, error: `at most ${LIVE_SOCKETS_PER_CLIENT} live sockets open at once` };
    return { region };
  }

  /** Add a socket to `region`'s room; `holder` is the client address {@link admit} counts it against. */
  join(region: string, socket: RoomSocket, holder = ""): RoomMember {
    let room = this.rooms.get(region);
    if (!room) this.rooms.set(region, (room = new Map()));
    const state: State = { alive: true, holder };
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
      leave: () => {
        members.delete(socket);
        // an empty room is forgotten, so rooms never accumulate for regions nobody listens on
        if (!members.size && this.rooms.get(region) === members) this.rooms.delete(region);
      },
    };
  }

  /** Terminate every member that has not answered since the last sweep, and ping the rest. */
  sweep(): void {
    for (const [region, room] of this.rooms) {
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
      if (!room.size) this.rooms.delete(region);
    }
  }

  /**
   * Call `fn` with every batch of envelopes dispatched to `region` until the returned function is called. A
   * listener that throws costs only its own delivery.
   */
  listen(region: string, holder: string, fn: (envelopes: LiveEnvelope[]) => void): () => void {
    let set = this.listeners.get(region);
    if (!set) this.listeners.set(region, (set = new Set()));
    const l: Listener = { holder, fn };
    set.add(l);
    const own = set;
    return () => {
      own.delete(l);
      if (!own.size && this.listeners.get(region) === own) this.listeners.delete(region);
    };
  }

  /** The listeners `holder` holds open, across every region. */
  holding(holder: string): number {
    let n = 0;
    for (const set of this.listeners.values()) for (const l of set) if (l.holder === holder) n++;
    return n;
  }

  /** Deliver live envelopes to each member per its subscription (live.ts `deliveriesFor`), and to each listener. */
  dispatch(region: string, envelopes: LiveEnvelope[]): void {
    for (const l of this.listeners.get(region) ?? [])
      try {
        l.fn(envelopes);
      } catch {
        /* one listener's failure is its own */
      }
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

/**
 * The room's internal endpoint. Only the gateway itself reaches it, over the `ROOMS` binding: the public
 * /ws route forwards the client's own request, whose path is /ws, so a client cannot broadcast.
 *
 *   POST /dispatch {envelopes}   fan the envelopes out (204)
 *
 * Anything else is 426: the room otherwise only takes a WebSocket upgrade.
 */
export async function serveRoom(req: Request, fanOut: (envelopes: unknown[]) => void): Promise<Response> {
  if (new URL(req.url).pathname === "/dispatch" && req.method === "POST") {
    const body = (await req.json().catch(() => null)) as { envelopes?: unknown[] } | null;
    if (!body || !Array.isArray(body.envelopes))
      return new Response(JSON.stringify({ error: "bad dispatch" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    fanOut(body.envelopes);
    return new Response(null, { status: 204 });
  }
  return new Response("expected websocket", { status: 426 });
}
