// SPDX-License-Identifier: MIT
/**
 * link-app.ts — the connected-mode session-server core: bind an AX.25 connected-mode link
 * (server side) to a line-oriented packet application (the BBS or the NET/ROM node CLI). On connect it
 * sends the app's greeting; received bytes are buffered and split into CR/LF-delimited command lines,
 * each handed to `app.handle()`, whose reply lines are sent back as I-frames. Pure — the ingest supplies
 * a real `ConnectedLink` + KISS transport; the loopback harness supplies a simulated one. Both `BbsSession`
 * and `NodeSession` already satisfy `LineApp`, so this glue serves either.
 */
import {
  ConnectedLink,
  PID_NETROM,
  type Ax25Frame,
  type Ax25Address,
  type LinkConfig,
  type LinkState,
} from "@aprscaching/ax25";

/** One command's outcome: reply lines, and optionally tear down or route onward. */
export interface LineReply {
  lines: string[];
  disconnect?: boolean;
  connect?: string;
}

/** A line-oriented packet app: a greeting on connect, then one reply per command line. `connect` asks the
 *  server to route the session onward (NET/ROM connect-through) to the named destination. `handle` MAY
 *  be async (an app whose replies come from I/O, e.g. the federation sync service fetching a page) —
 *  the driver serializes lines strictly in order either way. */
export interface LineApp {
  greeting(): string[];
  handle(input: string): LineReply | Promise<LineReply>;
}

/**
 * A controller the server hands to `onConnect` to bridge the inbound user link to an onward circuit
 * (NET/ROM connect-through). `attach` switches the link to transparent relay: subsequent user bytes go to
 * `sink` instead of the line app; `toUser` sends bytes back to the user; `detach` returns to command mode.
 */
export interface RelayController {
  toUser(bytes: Uint8Array): void;
  attach(sink: (bytes: Uint8Array) => void): void;
  detach(): void;
  disconnectUser(): void;
}

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const dec = (b: Uint8Array): string => new TextDecoder().decode(b);

/** A single un-terminated "line" must not grow the receive buffer without bound. A real
 *  command line is a handful of bytes; 8 KiB with no CR/LF is a hostile/broken peer → drop the link. */
const MAX_LINE_BUF = 8 * 1024;

/** The transport-agnostic side of a line session: feed bytes/up/down, it drives the app. */
export interface LineDriver {
  onData(info: Uint8Array): void;
  onUp(): void;
  onDown(): void;
}

/**
 * The transport-neutral core that binds a `LineApp` to a byte duplex: buffers received bytes into CR/LF
 * lines, hands each to `app.handle`, sends replies back, greets on connect, and supports connect-through
 * relay. `io.send` writes bytes to the peer; `io.disconnect` tears the session down. Reused by `serveApp`
 * (over an AX.25 `ConnectedLink`) and `serveNetromApp` (over a NET/ROM `NetromCircuit`).
 */
export function makeLineDriver(
  app: LineApp,
  io: {
    send: (bytes: Uint8Array) => void;
    disconnect: () => void;
    onConnect?: (dest: string, relay: RelayController) => void;
  },
): LineDriver {
  let buf = "";
  let greeted = false;
  let relaySink: ((bytes: Uint8Array) => void) | null = null;
  const push = (lines: string[]) => {
    if (lines.length) io.send(enc(lines.join("\r") + "\r"));
  };
  const relay: RelayController = {
    toUser: (bytes) => io.send(bytes),
    attach: (sink) => {
      relaySink = sink;
      buf = "";
    },
    detach: () => {
      relaySink = null;
    },
    disconnectUser: () => io.disconnect(),
  };
  // A sync `handle` runs inline exactly as before; an async one PAUSES the pump until it settles, so
  // commands are processed and answered strictly in arrival order (H before R matters). `gen` fences a
  // reply that settles after the link went down — it must not leak into a later session.
  let busy = false;
  let gen = 0;
  const apply = (r: LineReply) => {
    push(r.lines);
    if (r.connect && io.onConnect) io.onConnect(r.connect, relay);
    if (r.disconnect) io.disconnect();
  };
  const pump = () => {
    while (!busy) {
      const i = buf.search(/[\r\n]/);
      if (i < 0) return;
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      const r = app.handle(line);
      if (r instanceof Promise) {
        busy = true;
        const g = gen;
        r.then(
          (rr) => {
            busy = false;
            if (g === gen) {
              apply(rr);
              pump();
            }
          },
          () => {
            busy = false;
            if (g === gen) io.disconnect(); // an app that throws mid-command is not recoverable
          },
        );
        return;
      }
      apply(r);
    }
  };
  return {
    onData(info) {
      if (relaySink) {
        relaySink(info);
        return;
      } // transparent relay (connect-through) — no line-splitting
      buf += dec(info);
      if (buf.length > MAX_LINE_BUF) {
        buf = "";
        io.disconnect(); // no line terminator in 8 KiB → hostile/garbage stream, tear down
        return;
      }
      pump();
    },
    onUp() {
      if (!greeted) {
        greeted = true;
        push(app.greeting());
      }
    },
    onDown() {
      greeted = false;
      buf = "";
      relaySink = null;
      busy = false;
      gen++;
    },
  };
}

/**
 * Stand up the server side of a connected-mode session: a `ConnectedLink` whose received data drives the
 * given `LineApp`. Returns the link — the caller pumps inbound frames via `link.onReceive(frame)` and runs
 * timers via `link.poll()`. `send` transmits a frame to the peer (KISS transport, or the loopback channel).
 * When the app returns `{connect}`, `onConnect` fires with a `RelayController` for connect-through.
 */
export function serveApp(
  local: Ax25Address,
  remote: Ax25Address,
  app: LineApp,
  opts: {
    send: (f: Ax25Frame) => void;
    clock?: () => number;
    cfg?: Partial<LinkConfig>;
    onState?: (s: LinkState) => void;
    onConnect?: (dest: string, relay: RelayController) => void;
    /** Consume I-frame payloads carrying NET/ROM network packets (PID 0xCF). Real neighbour
     *  nodes (BPQ, TheNet lineage) multiplex routing/L4 traffic and plain text on one L2
     *  session — without this hook those packets would reach the line app as garbage text. */
    onNetrom?: (packet: Uint8Array) => void;
  },
): ConnectedLink {
  // eslint-disable-next-line prefer-const -- the driver closes over `link` before it is assigned
  let link: ConnectedLink;
  const driver = makeLineDriver(app, {
    send: (b) => link.send(b),
    disconnect: () => link.disconnect(),
    onConnect: opts.onConnect,
  });
  link = new ConnectedLink(
    local,
    remote,
    {
      send: opts.send,
      deliver: (info: Uint8Array, pid?: number) => {
        if (pid === PID_NETROM && opts.onNetrom) return opts.onNetrom(info);
        driver.onData(info);
      },
      state: (s: LinkState) => {
        if (s === "connected") driver.onUp();
        else if (s === "disconnected") driver.onDown();
        opts.onState?.(s);
      },
    },
    opts.cfg,
    opts.clock,
  );

  return link;
}
