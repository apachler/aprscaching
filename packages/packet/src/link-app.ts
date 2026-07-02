// SPDX-License-Identifier: MIT
/**
 * link-app.ts — the connected-mode session-server core (docs/29 F1): bind an AX.25 connected-mode link
 * (server side) to a line-oriented packet application (the BBS or the NET/ROM node CLI). On connect it
 * sends the app's greeting; received bytes are buffered and split into CR/LF-delimited command lines,
 * each handed to `app.handle()`, whose reply lines are sent back as I-frames. Pure — the ingest supplies
 * a real `ConnectedLink` + KISS transport; the loopback harness supplies a simulated one. Both `BbsSession`
 * and `NodeSession` already satisfy `LineApp`, so this glue serves either.
 */
import { ConnectedLink, type Ax25Frame, type Ax25Address, type LinkConfig, type LinkState } from "@aprsweb/ax25";

/** A line-oriented packet app: a greeting on connect, then one reply per command line. `connect` asks the
 *  server to route the session onward (NET/ROM connect-through) to the named destination. */
export interface LineApp {
  greeting(): string[];
  handle(input: string): { lines: string[]; disconnect?: boolean; connect?: string };
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

/** The transport-agnostic side of a line session: feed bytes/up/down, it drives the app. */
export interface LineDriver { onData(info: Uint8Array): void; onUp(): void; onDown(): void }

/**
 * The transport-neutral core that binds a `LineApp` to a byte duplex: buffers received bytes into CR/LF
 * lines, hands each to `app.handle`, sends replies back, greets on connect, and supports connect-through
 * relay. `io.send` writes bytes to the peer; `io.disconnect` tears the session down. Reused by `serveApp`
 * (over an AX.25 `ConnectedLink`) and `serveNetromApp` (over a NET/ROM `NetromCircuit`).
 */
export function makeLineDriver(
  app: LineApp,
  io: { send: (bytes: Uint8Array) => void; disconnect: () => void; onConnect?: (dest: string, relay: RelayController) => void },
): LineDriver {
  let buf = "";
  let greeted = false;
  let relaySink: ((bytes: Uint8Array) => void) | null = null;
  const push = (lines: string[]) => { if (lines.length) io.send(enc(lines.join("\r") + "\r")); };
  const relay: RelayController = {
    toUser: (bytes) => io.send(bytes),
    attach: (sink) => { relaySink = sink; buf = ""; },
    detach: () => { relaySink = null; },
    disconnectUser: () => io.disconnect(),
  };
  return {
    onData(info) {
      if (relaySink) { relaySink(info); return; }          // transparent relay (connect-through) — no line-splitting
      buf += dec(info);
      let i: number;
      while ((i = buf.search(/[\r\n]/)) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        const r = app.handle(line);
        push(r.lines);
        if (r.connect && io.onConnect) io.onConnect(r.connect, relay);
        if (r.disconnect) io.disconnect();
      }
    },
    onUp() { if (!greeted) { greeted = true; push(app.greeting()); } },
    onDown() { greeted = false; buf = ""; relaySink = null; },
  };
}

/**
 * Stand up the server side of a connected-mode session: a `ConnectedLink` whose received data drives the
 * given `LineApp`. Returns the link — the caller pumps inbound frames via `link.onReceive(frame)` and runs
 * timers via `link.poll()`. `send` transmits a frame to the peer (KISS transport, or the loopback channel).
 * When the app returns `{connect}`, `onConnect` fires with a `RelayController` for connect-through.
 */
export function serveApp(
  local: Ax25Address, remote: Ax25Address, app: LineApp,
  opts: {
    send: (f: Ax25Frame) => void; clock?: () => number; cfg?: Partial<LinkConfig>;
    onState?: (s: LinkState) => void; onConnect?: (dest: string, relay: RelayController) => void;
  },
): ConnectedLink {
  // eslint-disable-next-line prefer-const -- the driver closes over `link` before it is assigned
  let link: ConnectedLink;
  const driver = makeLineDriver(app, { send: (b) => link.send(b), disconnect: () => link.disconnect(), onConnect: opts.onConnect });
  link = new ConnectedLink(local, remote, {
    send: opts.send,
    deliver: (info: Uint8Array) => driver.onData(info),
    state: (s: LinkState) => {
      if (s === "connected") driver.onUp();
      else if (s === "disconnected") driver.onDown();
      opts.onState?.(s);
    },
  }, opts.cfg, opts.clock);

  return link;
}
