// SPDX-License-Identifier: MIT
/**
 * clients.ts — the clients of a KISS server and the radio ports each one sees.
 *
 * The server exposes the box's radio ports as KISS port numbers (0–15) through a port map. A client sees either
 * every mapped port under its own number, or, on a listener that carries one port, that port alone as KISS
 * port 0: the shape of Direwolf's `KISSPORT <tcp> <channel>`, for applications that know only port 0. What a
 * radio port hears reaches each client whose view holds it, on the number that client knows it by; what a client
 * sends on a port number it does not see goes nowhere.
 *
 * Pure: the connection type is the caller's, and nothing here touches a socket.
 */
import { kissDataFrame } from "./framing.js";

/** One exposed radio port: the KISS port number clients see and the box's name for the radio port. */
export interface PortMapEntry {
  kiss: number;
  radio: string;
}

const isKissPort = (n: number) => Number.isInteger(n) && n >= 0 && n <= 15;

/**
 * The port map from a comma list of `[<kiss port>=]<radio port>` (an entry without a number takes its place in
 * the list as its number), or the box's radio ports in order when the list is empty. Throws on a radio port the
 * box does not have, a number outside 0–15, a number or radio port listed twice, or more than sixteen ports.
 */
export function parsePortMap(spec: string | undefined, radios: readonly string[]): PortMapEntry[] {
  const items = (spec ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const entries: PortMapEntry[] = items.length
    ? items.map((item, i) => {
        const m = /^(?:(\d{1,2})\s*=\s*)?(\S+)$/.exec(item);
        if (!m) throw new Error(`"${item}" is not [<kiss port>=]<radio port>`);
        return { kiss: m[1] === undefined ? i : Number(m[1]), radio: m[2]! };
      })
    : radios.map((radio, i) => ({ kiss: i, radio }));
  if (entries.length > 16) throw new Error(`${entries.length} radio ports: KISS numbers only sixteen (0-15)`);
  const kiss = new Set<number>();
  const named = new Set<string>();
  for (const e of entries) {
    if (!isKissPort(e.kiss)) throw new Error(`KISS port ${e.kiss} is not 0-15`);
    if (!radios.includes(e.radio))
      throw new Error(`"${e.radio}" is not a radio port of this box (${radios.join(", ") || "none"})`);
    if (kiss.has(e.kiss)) throw new Error(`KISS port ${e.kiss} is mapped twice`);
    if (named.has(e.radio)) throw new Error(`radio port ${e.radio} is mapped twice`);
    kiss.add(e.kiss);
    named.add(e.radio);
  }
  return entries;
}

/** A listener that carries one KISS port to its clients as port 0. */
export interface SinglePortListener {
  tcpPort: number;
  kiss: number;
}

/**
 * Single-port listeners from a comma list of `<tcp port>=<kiss port>`. Throws on a malformed entry, a TCP port
 * outside 1–65535 or listed twice, or a KISS port the map does not hold.
 */
export function parseListeners(spec: string | undefined, map: readonly PortMapEntry[]): SinglePortListener[] {
  const out: SinglePortListener[] = [];
  for (const item of (spec ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)) {
    const m = /^(\d{1,5})\s*=\s*(\d{1,2})$/.exec(item);
    if (!m) throw new Error(`"${item}" is not <tcp port>=<kiss port>`);
    const tcpPort = Number(m[1]);
    const kiss = Number(m[2]);
    if (tcpPort < 1 || tcpPort > 65535) throw new Error(`TCP port ${tcpPort} is not 1-65535`);
    if (out.some((l) => l.tcpPort === tcpPort)) throw new Error(`TCP port ${tcpPort} is listed twice`);
    if (!map.some((e) => e.kiss === kiss)) throw new Error(`KISS port ${kiss} is not mapped to a radio port`);
    out.push({ tcpPort, kiss });
  }
  return out;
}

interface Client<C> {
  conn: C;
  /** Radio port → the KISS port number this client knows it by. */
  out: Map<string, number>;
  /** The KISS port number this client sends on → radio port. */
  in: Map<number, string>;
}

/** A frame to write to one client. */
export interface Delivery<C> {
  conn: C;
  bytes: Uint8Array;
}

export class KissClients<C> {
  private clients = new Map<C, Client<C>>();
  constructor(
    private readonly map: readonly PortMapEntry[],
    private readonly maxClients: number,
  ) {}

  /** Clients connected now. */
  get size(): number {
    return this.clients.size;
  }

  /**
   * Admit a connection, seeing every mapped port or, with `only`, that one KISS port as port 0. False when the
   * server is full (the caller closes the connection).
   */
  add(conn: C, only?: number): boolean {
    if (this.clients.size >= this.maxClients) return false;
    const seen = only === undefined ? this.map : this.map.filter((e) => e.kiss === only);
    const out = new Map(seen.map((e) => [e.radio, only === undefined ? e.kiss : 0] as const));
    this.clients.set(conn, { conn, out, in: new Map([...out].map(([radio, n]) => [n, radio] as const)) });
    return true;
  }

  remove(conn: C): void {
    this.clients.delete(conn);
  }

  /** The radio port a client means by a KISS port number, or null when it sees no port by that number. */
  radioFor(conn: C, kissPort: number): string | null {
    return this.clients.get(conn)?.in.get(kissPort) ?? null;
  }

  /** What a radio port heard, as a KISS data frame for each client that sees the port, on its number. */
  heard(radio: string, frame: Uint8Array): Delivery<C>[] {
    const out: Delivery<C>[] = [];
    const wrapped = new Map<number, Uint8Array>();
    for (const c of this.clients.values()) {
      const n = c.out.get(radio);
      if (n === undefined) continue;
      let bytes = wrapped.get(n);
      if (!bytes) wrapped.set(n, (bytes = kissDataFrame(frame, n)));
      out.push({ conn: c.conn, bytes });
    }
    return out;
  }
}
