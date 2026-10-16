// SPDX-License-Identifier: MIT
/**
 * kissserver.ts — the core of a KISS-over-TCP server that shares a station's radio ports with other packet
 * applications: the clients and their views (clients.ts), each client's KISS stream (framing.ts), the transmit
 * policy, and the per-port arbiter (arbiter.ts). The host owns the sockets, the clock that paces the radio, and
 * the radios; this class decides what each client hears and which client frame goes out next.
 *
 * Receive: every frame a radio port hears goes to every client that sees the port.
 *
 * Transmit is off unless the host turns it on. With it on, a client's data frame is queued for its radio port
 * only when the client sees that port, the bytes hold a valid AX.25 address field, and the source's base call is
 * one the policy lists. Everything else is dropped and counted per client and reason. Command frames are set
 * aside (framing.ts). A queued frame still passes the station's own transmit gate when its turn comes; the core
 * names the base call it goes out under, for that gate.
 */
import { baseCall } from "@aprscaching/aprs";
import { TxArbiter, type ArbiterOpts, type DropReason } from "./arbiter.js";
import { KissClients, type Delivery, type PortMapEntry } from "./clients.js";
import { KissClientStream, frameAddresses, type StreamCounts } from "./framing.js";

/** Why a client's data frame did not reach the radio. */
export type TxRefusal =
  /** Transmit through the server is off. */
  | "tx-off"
  /** The client sees no radio port by that KISS number. */
  | "port"
  /** The bytes hold no valid AX.25 address field. */
  | "invalid"
  /** The source's base call is not one the server may transmit as. */
  | "call"
  /** The station's transmit gate refused it when its turn came (the host reports this). */
  | "gate"
  | DropReason;

export interface KissServerCoreOpts {
  map: readonly PortMapEntry[];
  maxClients: number;
  /** Whether clients may transmit at all. */
  tx: boolean;
  /** The base calls a client may transmit as. */
  txCalls: readonly string[];
  arbiter?: Partial<ArbiterOpts>;
}

/** A client frame whose turn has come, with the base call the station's gate judges it by. */
export interface TxTurn<C> {
  client: C;
  frame: Uint8Array;
  call: string;
}

/** One client's counts: what its stream held besides data, and its refused frames by reason. */
export interface ClientCounts extends StreamCounts {
  refused: Partial<Record<TxRefusal, number>>;
  /** Data frames queued for a radio. */
  queued: number;
}

const zero = (): ClientCounts => ({ commands: 0, overflows: 0, refused: {}, queued: 0 });

export class KissServerCore<C> {
  readonly clients: KissClients<C>;
  private arbiter: TxArbiter<C>;
  private streams = new Map<C, KissClientStream>();
  private counts = new Map<C, ClientCounts>();
  private calls: ReadonlySet<string>;
  constructor(private readonly o: KissServerCoreOpts) {
    this.clients = new KissClients(o.map, o.maxClients);
    this.arbiter = new TxArbiter<C>(o.arbiter);
    this.calls = new Set(o.txCalls.map(baseCall).filter(Boolean));
  }

  /** Admit a connection (see {@link KissClients.add}); false when the server is full. */
  connect(conn: C, only?: number): boolean {
    if (!this.clients.add(conn, only)) return false;
    this.streams.set(conn, new KissClientStream());
    this.counts.set(conn, zero());
    return true;
  }

  /** A connection closed: forget it and its waiting frames, and return its counts. */
  disconnect(conn: C): ClientCounts {
    const c = this.read(conn);
    this.clients.remove(conn);
    this.arbiter.remove(conn);
    this.streams.delete(conn);
    this.counts.delete(conn);
    return c;
  }

  /** What a radio port heard, for the clients that see it. */
  heard(radio: string, frame: Uint8Array): Delivery<C>[] {
    return this.clients.heard(radio, frame);
  }

  private refuse(conn: C, why: TxRefusal): void {
    const c = this.counts.get(conn);
    if (c) c.refused[why] = (c.refused[why] ?? 0) + 1;
  }

  /** The station's gate refused a frame whose turn had come. */
  gateRefused(conn: C): void {
    this.refuse(conn, "gate");
  }

  /** Feed a client's read. Returns the radio ports that have a new frame waiting. */
  receive(conn: C, chunk: Uint8Array): string[] {
    const stream = this.streams.get(conn);
    if (!stream) return [];
    const ports = new Set<string>();
    for (const f of stream.push(chunk)) {
      if (!this.o.tx) {
        this.refuse(conn, "tx-off");
        continue;
      }
      const radio = this.clients.radioFor(conn, f.port);
      if (!radio) {
        this.refuse(conn, "port");
        continue;
      }
      const addrs = frameAddresses(f.frame);
      if (!addrs) {
        this.refuse(conn, "invalid");
        continue;
      }
      if (!this.calls.has(baseCall(addrs.src))) {
        this.refuse(conn, "call");
        continue;
      }
      const offer = this.arbiter.offer(conn, radio, f.frame);
      if (offer.dropped) this.refuse(conn, offer.dropped);
      if (offer.queued) {
        this.counts.get(conn)!.queued++;
        ports.add(radio);
      }
    }
    return [...ports];
  }

  /** The next client frame for a radio port, in turn; null when none waits. */
  next(radio: string): TxTurn<C> | null {
    const t = this.arbiter.next(radio);
    if (!t) return null;
    const src = frameAddresses(t.frame)!.src;
    return { client: t.client, frame: t.frame, call: baseCall(src) };
  }

  /** The radio ports a client frame waits on. */
  waiting(): string[] {
    return this.arbiter.ports();
  }

  /** A client's counts so far, its arbiter drops included. */
  read(conn: C): ClientCounts {
    const c = this.counts.get(conn) ?? zero();
    const s = this.streams.get(conn)?.counts;
    const stale = this.arbiter.dropped(conn).stale;
    return {
      ...c,
      ...(s ?? {}),
      refused: { ...c.refused, ...(stale ? { stale } : {}) },
    };
  }
}
