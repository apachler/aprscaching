// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * forwarder.ts — the ingest adapters for the FBB forwarding scheduler. The scheduler brain
 * (`BbsForwarder`) is pure and lives in `@aprscaching/packet`; here we supply its two I/O dependencies: a
 * `GatewayApi` (the forwarding-pool REST client, x-ingest-secret gated) and `kissForwardLink` (a real
 * connected-mode AX.25 link over KISS-TCP). `startForwarder` wires them together from env. The message
 * store stays in the cloud; the RF session runs here (ingest-locality).
 *
 * Multi-hop connect scripts (`C NODE1` → `C 3 DB0XYZ`) and AXUDP partners are validate-at-deploy — the
 * default link does a single direct connect to the partner call and logs the script for the operator.
 */
import net from "node:net";
import { kissWrap, kissFrames } from "@aprscaching/aprs";
import type { FrameLink } from "./link.js";
import { ConnectedLink, encodeFrame, decodeFrame, parseAddr, type Ax25Frame, type LinkState } from "@aprscaching/ax25";
import {
  BbsForwarder,
  ConnectSequencer,
  parseConnectScript,
  type ForwardApi,
  type ForwardLink,
  type GwPartner,
  type FbbMessage,
  type CachedBbsBackend,
  type BbsMsgFull,
  type BbsType,
} from "@aprscaching/packet";

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

/** The gateway REST client for the forwarding pool (all endpoints x-ingest-secret gated). */
export class GatewayApi implements ForwardApi {
  constructor(
    private base: string,
    private secret: string,
  ) {}
  private h() {
    return { "content-type": "application/json", "x-ingest-secret": this.secret };
  }
  async partners(): Promise<GwPartner[]> {
    const r = await fetch(`${this.base}/api/bbs/partners`, { headers: { "x-ingest-secret": this.secret } });
    return ((await r.json()) as { partners?: GwPartner[] }).partners ?? [];
  }
  async pool(call: string): Promise<FbbMessage[]> {
    const r = await fetch(`${this.base}/api/bbs/forward/pool?partner=${encodeURIComponent(call)}`, {
      headers: { "x-ingest-secret": this.secret },
    });
    return ((await r.json()) as { messages?: FbbMessage[] }).messages ?? [];
  }
  async inbound(message: FbbMessage, origin: string): Promise<void> {
    await fetch(`${this.base}/api/bbs/forward/inbound`, {
      method: "POST",
      headers: this.h(),
      body: JSON.stringify({ message, origin }),
    });
  }
  async markSent(partner: string, bids: string[]): Promise<void> {
    if (!bids.length) return;
    await fetch(`${this.base}/api/bbs/forward/sent`, {
      method: "POST",
      headers: this.h(),
      body: JSON.stringify({ partner, bids }),
    });
  }
}

/** A gateway-backed CachedBbsBackend for an inbound connected-mode BBS session. */
export function gatewayBbsBackend(base: string, secret: string): CachedBbsBackend {
  const h = () => ({ "content-type": "application/json", "x-ingest-secret": secret });
  return {
    load: async (call) => {
      const r = await fetch(`${base}/api/bbs/session?call=${encodeURIComponent(call)}`, {
        headers: { "x-ingest-secret": secret },
      });
      return ((await r.json()) as { messages?: BbsMsgFull[] }).messages ?? [];
    },
    post: async (m: {
      type: BbsType;
      from: string;
      to: string;
      subject: string | null;
      body: string;
      replyTo?: number | null;
    }) => {
      const r = await fetch(`${base}/api/bbs/messages`, {
        method: "POST",
        headers: h(),
        body: JSON.stringify({
          fromCall: m.from,
          toCall: m.to,
          type: m.type,
          subject: m.subject ?? undefined,
          body: m.body,
          replyTo: m.replyTo ?? undefined,
        }),
      });
      return ((await r.json().catch(() => ({}))) as { id?: number }).id ?? 0;
    },
    markRead: async (id) => {
      await fetch(`${base}/api/bbs/messages/${id}/read`, { method: "POST", headers: h() });
    },
    kill: async (id, call) => {
      await fetch(`${base}/api/bbs/kill`, { method: "POST", headers: h(), body: JSON.stringify({ id, call }) });
    },
  };
}

/** Build + start a forwarder from env config (a KISS-TCP or shared frame link + the gateway pool). */
export function startForwarder(o: {
  base: string;
  secret: string;
  mycall: string;
  kiss?: { host: string; port: number };
  link?: FrameLink; // an already-running frame pipe (AXUDP) shared with the connected stack
  pollMs?: number;
  sid?: string;
  compress?: boolean; // offer LZHUF-B1 compressed forwarding (engages only when the partner also does)
}): BbsForwarder {
  const fwd = new BbsForwarder({
    api: new GatewayApi(o.base, o.secret),
    linkFactory: (p) =>
      o.kiss
        ? kissForwardLink({
            host: o.kiss.host,
            port: o.kiss.port,
            mycall: o.mycall,
            partnerCall: p.call,
            connectScript: p.connectScript,
          })
        : frameForwardLink(o.link!, { mycall: o.mycall, partnerCall: p.call, connectScript: p.connectScript }),
    pollMs: o.pollMs,
    sid: o.sid,
    compress: o.compress,
  });
  fwd.start();
  return fwd;
}

/**
 * A connected-mode FBB link over KISS-TCP: a raw-frame KISS socket driving a `ConnectedLink` (AX.25 v2.2)
 * to the partner. Direct single-hop connect; the multi-hop connect script is logged (validate-at-deploy).
 */
export function kissForwardLink(o: {
  host: string;
  port: number;
  mycall: string;
  partnerCall: string;
  connectScript: string;
}): ForwardLink {
  const local = parseAddr(o.mycall);
  // A connect script routes through node(s): connect the AX.25 link to the FIRST hop, then sequence the
  // rest with ConnectSequencer. No script → connect directly to the partner.
  const steps = parseConnectScript(o.connectScript);
  const firstHop = steps.length ? steps[0]!.call : o.partnerCall;
  const remote = parseAddr(firstHop);

  let sock: net.Socket | null = null;
  let rxBuf: number[] = [];
  let sequencing = false; // while true, delivered bytes drive the sequencer, not the app
  let seq: ConnectSequencer | null = null;
  const dataCbs: ((b: Uint8Array) => void)[] = [];
  const closeCbs: (() => void)[] = [];
  const fireClose = () => {
    for (const c of closeCbs.splice(0)) c();
  };

  const link = new ConnectedLink(local, remote, {
    send: (f: Ax25Frame) => {
      try {
        sock?.write(kissWrap(encodeFrame(f)));
      } catch {
        /* link down */
      }
    },
    deliver: (info: Uint8Array) => {
      if (sequencing) seq?.feed(info);
      else for (const c of dataCbs) c(info);
    },
    state: (s: LinkState) => {
      if (s === "disconnected") fireClose();
    },
    error: (msg: string) => console.error(`[forward] ${o.partnerCall} link error: ${msg}`),
  });
  const poll = setInterval(() => link.poll(), 1000);

  return {
    connect: () =>
      new Promise<void>((resolve, reject) => {
        const s = net.connect(o.port, o.host);
        sock = s;
        s.on("connect", () => link.connect());
        s.on("data", (chunk: Buffer) => {
          for (const b of chunk) rxBuf.push(b);
          const lastFend = rxBuf.lastIndexOf(0xc0);
          if (lastFend <= 0) return;
          const ready = Uint8Array.from(rxBuf.slice(0, lastFend + 1));
          rxBuf = rxBuf.slice(lastFend + 1);
          for (const raw of kissFrames(ready)) {
            const f = decodeFrame(raw);
            if (f) link.onReceive(f);
          }
        });
        s.on("error", (e) => {
          clearInterval(poll);
          s.destroy();
          reject(e);
        }); // don't leak the socket/timer
        s.on("close", () => {
          clearInterval(poll);
          fireClose();
        });
        const settle = () => {
          // AX.25 link to the first hop is up
          if (steps.length <= 1) return resolve(); // direct partner → ready
          sequencing = true; // multi-hop: sequence "C <next>" through the node(s)
          seq = new ConnectSequencer(steps, {
            send: (line) => link.send(enc(line + "\r")),
            onReady: () => {
              sequencing = false;
              resolve();
            },
            onFail: (why) => reject(new Error(`connect script failed: ${why}`)),
          });
          seq.start();
        };
        const wait = setInterval(() => {
          if (link.state === "connected") {
            clearInterval(wait);
            settle();
          }
        }, 200);
        // On connect timeout, tear down the KISS socket + poll timer (else Direwolf's few slots fill
        // and lock out the main ingest); destroying triggers `close` which clears `poll`.
        setTimeout(() => {
          clearInterval(wait);
          if (link.state !== "connected") {
            s.destroy();
            reject(new Error("connect timeout"));
          }
        }, 30_000);
      }),
    send: (bytes: Uint8Array) => link.send(bytes),
    onData: (cb) => {
      dataCbs.push(cb);
    },
    onClose: (cb) => {
      closeCbs.push(cb);
    },
    disconnect: () => {
      link.disconnect();
      setTimeout(() => {
        clearInterval(poll);
        sock?.end();
      }, 500);
    },
  };
}

/**
 * A connected-mode FBB link over a shared frame pipe (AXUDP): the same `ConnectedLink` (AX.25 v2.2)
 * as the KISS variant, but frames ride an already-running `FrameLink` instead of a per-session KISS
 * socket. The pipe is shared with the NET/ROM node and session server, so the raw subscription is
 * removed when the session ends — a long-running box must not accumulate dead demux callbacks.
 */
export function frameForwardLink(
  pipe: FrameLink,
  o: { mycall: string; partnerCall: string; connectScript: string },
): ForwardLink {
  const local = parseAddr(o.mycall);
  const steps = parseConnectScript(o.connectScript);
  const firstHop = steps.length ? steps[0]!.call : o.partnerCall;
  const remote = parseAddr(firstHop);

  let sequencing = false;
  let seq: ConnectSequencer | null = null;
  let closed = false;
  const dataCbs: ((b: Uint8Array) => void)[] = [];
  const closeCbs: (() => void)[] = [];
  const fireClose = () => {
    if (closed) return;
    closed = true;
    clearInterval(poll);
    pipe.offRaw?.(onRaw);
    for (const c of closeCbs.splice(0)) c();
  };

  const link = new ConnectedLink(local, remote, {
    send: (f: Ax25Frame) => void pipe.sendFrame(f),
    deliver: (info: Uint8Array) => {
      if (sequencing) seq?.feed(info);
      else for (const c of dataCbs) c(info);
    },
    state: (s: LinkState) => {
      if (s === "disconnected") fireClose();
    },
    error: (msg: string) => console.error(`[forward] ${o.partnerCall} link error: ${msg}`),
  });
  const poll = setInterval(() => link.poll(), 1000);
  const onRaw = (b: Uint8Array) => {
    const f = decodeFrame(b);
    if (f) link.onReceive(f);
  };
  pipe.onRaw(onRaw);

  return {
    connect: () =>
      new Promise<void>((resolve, reject) => {
        link.connect();
        const settle = () => {
          if (steps.length <= 1) return resolve();
          sequencing = true;
          seq = new ConnectSequencer(steps, {
            send: (line) => link.send(enc(line + "\r")),
            onReady: () => {
              sequencing = false;
              resolve();
            },
            onFail: (why) => reject(new Error(`connect script failed: ${why}`)),
          });
          seq.start();
        };
        const wait = setInterval(() => {
          if (link.state === "connected") {
            clearInterval(wait);
            settle();
          }
        }, 200);
        setTimeout(() => {
          clearInterval(wait);
          if (link.state !== "connected") {
            fireClose();
            reject(new Error("connect timeout"));
          }
        }, 30_000);
      }),
    send: (bytes: Uint8Array) => link.send(bytes),
    onData: (cb) => {
      dataCbs.push(cb);
    },
    onClose: (cb) => {
      closeCbs.push(cb);
    },
    disconnect: () => {
      link.disconnect();
      setTimeout(fireClose, 500);
    },
  };
}
