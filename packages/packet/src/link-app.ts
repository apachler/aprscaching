/**
 * link-app.ts — the connected-mode session-server core (docs/29 F1): bind an AX.25 connected-mode link
 * (server side) to a line-oriented packet application (the BBS or the NET/ROM node CLI). On connect it
 * sends the app's greeting; received bytes are buffered and split into CR/LF-delimited command lines,
 * each handed to `app.handle()`, whose reply lines are sent back as I-frames. Pure — the ingest supplies
 * a real `ConnectedLink` + KISS transport; the loopback harness supplies a simulated one. Both `BbsSession`
 * and `NodeSession` already satisfy `LineApp`, so this glue serves either.
 */
import { ConnectedLink, type Ax25Frame, type Ax25Address, type LinkConfig, type LinkState } from "@aprsweb/ax25";

/** A line-oriented packet app: a greeting on connect, then one reply per command line. */
export interface LineApp {
  greeting(): string[];
  handle(input: string): { lines: string[]; disconnect?: boolean };
}

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const dec = (b: Uint8Array): string => new TextDecoder().decode(b);

/**
 * Stand up the server side of a connected-mode session: a `ConnectedLink` whose received data drives the
 * given `LineApp`. Returns the link — the caller pumps inbound frames via `link.onReceive(frame)` and runs
 * timers via `link.poll()`. `send` transmits a frame to the peer (KISS transport, or the loopback channel).
 */
export function serveApp(
  local: Ax25Address, remote: Ax25Address, app: LineApp,
  opts: { send: (f: Ax25Frame) => void; clock?: () => number; cfg?: Partial<LinkConfig>; onState?: (s: LinkState) => void },
): ConnectedLink {
  let buf = "";
  let greeted = false;
  // eslint-disable-next-line prefer-const -- the events close over `link` before it is assigned
  let link: ConnectedLink;
  const push = (lines: string[]) => { if (lines.length) link.send(enc(lines.join("\r") + "\r")); };

  link = new ConnectedLink(local, remote, {
    send: opts.send,
    deliver: (info: Uint8Array) => {
      buf += dec(info);
      let i: number;
      while ((i = buf.search(/[\r\n]/)) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        const r = app.handle(line);
        push(r.lines);
        if (r.disconnect) link.disconnect();
      }
    },
    state: (s: LinkState) => {
      if (s === "connected" && !greeted) { greeted = true; push(app.greeting()); }
      if (s === "disconnected") { greeted = false; buf = ""; }
      opts.onState?.(s);
    },
  }, opts.cfg, opts.clock);

  return link;
}
