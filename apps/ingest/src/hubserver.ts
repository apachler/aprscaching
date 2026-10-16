// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * hubserver.ts — the KISS-over-TCP server: other packet applications (APRSIS32, Xastir, YAAC, `kissutil`, Linux
 * `kissattach`, QtTermTCP) use the box's radio ports as their TNC, alongside APRScaching.
 *
 * The server runs inside the ingest process. Its decisions (each client's view of the ports, its KISS stream, the
 * transmit policy and the per-port arbiter) are `@aprscaching/hub`'s `KissServerCore`, which holds no socket and
 * no timer, so the same core can run in a separate hub daemon beside the ingest. This module owns the sockets, the
 * box's pacing and the hand-off to the radios.
 *
 * Receive: every frame a radio port the server exposes hears goes to every client that sees the port. That is what
 * the port hands the box's own functions: the box's own transmissions, and the client frames it sent, never come
 * back as hearings (echo.ts), and neither does a frame one client sends reach the others. The box's LoRa APRS port
 * is not exposed: its packets are TNC2 text, not AX.25, and the port never transmits.
 *
 * Transmit is off unless `KISS_SERVER_TX=1`. With it on, a client frame whose source's base call
 * `KISS_SERVER_TX_CALLS` lists waits its turn in the arbiter, then draws from the server's own token bucket
 * (txlimit.ts, `hub`), then passes the radio port's transmit gate: the box's master switch and the gateway's
 * confirmation of that base call (callverify.ts). A client frame is only ever transmitted. It never enters the
 * batch the box posts to the gateway: it did not cross the air to the box's receiver, so it is no hearing, and the
 * receiving site never attests it. Its echo is dropped like any frame the box sent.
 *
 * KISS commands from clients (TXDELAY, PERSIST, SLOTTIME, TXTAIL, FULLDUPLEX, SETHARDWARE, return-from-KISS) are
 * ignored: the box sets its TNC's timing, and one client must not change the channel access the others share.
 */
import net from "node:net";
import { baseCall } from "@aprscaching/aprs";
import {
  KissServerCore,
  parseListeners,
  parsePortMap,
  type ClientCounts,
  type PortMapEntry,
  type SinglePortListener,
  type TxRefusal,
} from "@aprscaching/hub";
import { numEnv } from "./config.js";
import { TokenBucket, txLimitFromEnv } from "./txlimit.js";

/** A radio port the server can expose: its name, and its raw transmit, gated as going out under a call. */
export interface HubRadio {
  name: string;
  sendRaw(frame: Uint8Array, call: string): boolean;
}

export interface KissServerSettings {
  host: string;
  port: number;
  /** Extra listeners, each carrying one KISS port as port 0. */
  listeners: SinglePortListener[];
  map: PortMapEntry[];
  maxClients: number;
  tx: boolean;
  /** The base calls a client may transmit as. */
  txCalls: string[];
  /** The server's token bucket: frames at once, then one more every `refillSec`. */
  pacing: { burst: number; refillSec: number };
}

/** Clients at once unless `KISS_SERVER_MAX_CLIENTS` says otherwise. */
const MAX_CLIENTS_DEFAULT = 8;
/** A client that has this much unread output is not reading: it is dropped, so the box's memory stays bounded. */
const CLIENT_BACKLOG_MAX = 256 * 1024;

const tcpPort = (key: string, v: string): number => {
  const n = Number(v.trim());
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error(`${key}: "${v}" is not a TCP port 1-65535`);
  return n;
};

/**
 * The server's settings from env, or null when `KISS_SERVER_PORT` is unset (the server is off). `radios` are the
 * box's radio ports in order, `stationCalls` the box's station calls (the default transmit calls). Throws on a
 * setting the server cannot run with.
 */
export function kissServerSettings(
  env: Record<string, string | undefined>,
  radios: readonly string[],
  stationCalls: readonly string[],
): KissServerSettings | null {
  const portRaw = (env.KISS_SERVER_PORT ?? "").trim();
  if (!portRaw) return null;
  const port = tcpPort("KISS_SERVER_PORT", portRaw);
  if (!radios.length)
    throw new Error("KISS_SERVER_PORT: the box has no radio port to share (set KISS_TNC_HOST or SOUNDCARD_DEVICE)");
  const at = (key: string, f: () => unknown) => {
    try {
      return f();
    } catch (e) {
      throw new Error(`${key}: ${(e as Error).message}`, { cause: e });
    }
  };
  const map = at("KISS_SERVER_PORTS", () => parsePortMap(env.KISS_SERVER_PORTS, radios)) as PortMapEntry[];
  const listeners = at("KISS_SERVER_PORT_LISTENERS", () =>
    parseListeners(env.KISS_SERVER_PORT_LISTENERS, map),
  ) as SinglePortListener[];
  if (listeners.some((l) => l.tcpPort === port))
    throw new Error(`KISS_SERVER_PORT_LISTENERS: TCP port ${port} is KISS_SERVER_PORT already`);
  const listed = (env.KISS_SERVER_TX_CALLS ?? "")
    .split(",")
    .map((c) => baseCall(c))
    .filter(Boolean);
  const txCalls = [...new Set(listed.length ? listed : stationCalls.map(baseCall).filter(Boolean))];
  return {
    host: (env.KISS_SERVER_HOST ?? "").trim() || "127.0.0.1",
    port,
    listeners,
    map,
    maxClients: Math.floor(numEnv("KISS_SERVER_MAX_CLIENTS", MAX_CLIENTS_DEFAULT, { min: 1, max: 64 }, env)),
    tx: env.KISS_SERVER_TX === "1",
    txCalls,
    pacing: txLimitFromEnv("hub"),
  };
}

/** What a refusal means, for the log. */
const REFUSAL_TEXT: Record<TxRefusal, string> = {
  "tx-off": "transmit through the server is off (KISS_SERVER_TX=1 turns it on)",
  port: "it sent on a KISS port it does not see",
  invalid: "it sent bytes that are no AX.25 frame",
  call: "it sent a frame whose source is not a call KISS_SERVER_TX_CALLS lists",
  gate: "the box's transmit gate refused a frame (the log above says why)",
  "frame-budget": "it sent more frames a minute than a client may",
  "byte-budget": "it sent more bytes a minute than a client may",
  "queue-full": "it queued more frames than a client may have waiting; the oldest were dropped",
  stale: "frames waited past a minute for their turn and were dropped",
};

export class KissServer {
  private core: KissServerCore<net.Socket>;
  private bucket: TokenBucket;
  private radios: Map<string, HubRadio>;
  private servers: net.Server[] = [];
  private names = new Map<net.Socket, string>();
  private logged = new Map<net.Socket, Set<TxRefusal>>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private log: (msg: string) => void;
  /** Client frames handed to a radio. */
  sent = 0;

  constructor(
    private s: KissServerSettings,
    radios: readonly HubRadio[],
    deps: { log?: (msg: string) => void; now?: () => number } = {},
  ) {
    this.core = new KissServerCore({ map: s.map, maxClients: s.maxClients, tx: s.tx, txCalls: s.txCalls });
    this.bucket = new TokenBucket({ ...s.pacing, now: deps.now });
    this.radios = new Map(radios.map((r) => [r.name, r]));
    this.log = deps.log ?? ((m) => console.log("[kiss-server] %s", m));
  }

  /** Listen on the server's port and each single-port listener; resolves once all are bound. */
  async start(): Promise<void> {
    const bind = (port: number, only?: number) =>
      new Promise<void>((resolve, reject) => {
        const srv = net.createServer((sock) => this.accept(sock, only));
        srv.once("error", reject);
        srv.listen(port, this.s.host, () => {
          srv.off("error", reject);
          srv.on("error", (e) => this.log(`listener error: ${e.message}`));
          resolve();
        });
        this.servers.push(srv);
      });
    await bind(this.s.port);
    for (const l of this.s.listeners) await bind(l.tcpPort, l.kiss);
  }

  /** The bound TCP ports, the server's own first (a port of 0 binds a free one). */
  ports(): number[] {
    return this.servers.map((s) => (s.address() as net.AddressInfo).port);
  }

  /** Close the listeners and every client. */
  async stop(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    for (const sock of this.names.keys()) sock.destroy();
    await Promise.all(this.servers.map((s) => new Promise<void>((r) => s.close(() => r()))));
    this.servers = [];
  }

  /** A frame a radio port heard: to every client that sees the port. */
  heard(radio: string, frame: Uint8Array): void {
    for (const d of this.core.heard(radio, frame)) {
      if (d.conn.writableLength > CLIENT_BACKLOG_MAX) {
        this.log(`${this.names.get(d.conn)} is not reading what it is sent; disconnected`);
        d.conn.destroy();
        continue;
      }
      d.conn.write(d.bytes);
    }
  }

  private accept(sock: net.Socket, only?: number): void {
    const name = `${sock.remoteAddress}:${sock.remotePort}`;
    if (!this.core.connect(sock, only)) {
      this.log(`${name} refused: ${this.s.maxClients} clients are connected already (KISS_SERVER_MAX_CLIENTS)`);
      sock.destroy();
      return;
    }
    this.names.set(sock, name);
    this.logged.set(sock, new Set());
    sock.setNoDelay(true);
    sock.setKeepAlive(true, 30_000);
    this.log(
      `${name} connected${only === undefined ? "" : ` (KISS port ${only} as port 0)`}, ${this.core.clients.size} of ${this.s.maxClients}`,
    );
    sock.on("data", (chunk: Buffer) => {
      const waiting = this.core.receive(sock, chunk);
      this.report(sock, this.core.read(sock));
      if (waiting.length) this.pump();
    });
    sock.on("error", () => {});
    sock.on("close", () => {
      const counts = this.core.disconnect(sock);
      this.report(sock, counts);
      this.names.delete(sock);
      this.logged.delete(sock);
      const refused = Object.entries(counts.refused)
        .map(([k, n]) => `${n} ${k}`)
        .join(", ");
      this.log(`${name} disconnected${refused ? ` (refused: ${refused})` : ""}`);
    });
  }

  /** Log each kind of refusal once per client, the first time it happens. */
  private report(sock: net.Socket, counts: ClientCounts): void {
    const seen = this.logged.get(sock);
    if (!seen) return;
    for (const [why, n] of Object.entries(counts.refused) as [TxRefusal, number][]) {
      if (!n || seen.has(why)) continue;
      seen.add(why);
      this.log(`${this.names.get(sock)}: ${REFUSAL_TEXT[why]}`);
    }
  }

  /** Hand waiting client frames to their radios, one per port in turn, as fast as the bucket allows. */
  private pump(): void {
    if (this.timer) return;
    for (;;) {
      const ports = this.core.waiting();
      if (!ports.length) return;
      for (const radio of ports) {
        const wait = this.bucket.waitSec();
        if (wait > 0) {
          this.timer = setTimeout(() => {
            this.timer = null;
            this.pump();
          }, wait * 1000);
          return;
        }
        const turn = this.core.next(radio);
        if (!turn) continue;
        this.bucket.take();
        const r = this.radios.get(radio);
        if (r?.sendRaw(turn.frame, turn.call)) this.sent++;
        else {
          this.core.gateRefused(turn.client);
          this.report(turn.client, this.core.read(turn.client));
        }
      }
    }
  }
}
