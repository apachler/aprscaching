// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * forwarder.ts — the ingest adapters for the FBB forwarding scheduler. The scheduler brain
 * (`BbsForwarder`) is pure and lives in `@aprscaching/packet`; here we supply its two I/O dependencies: a
 * `GatewayApi` (the forwarding-pool REST client, x-ingest-secret gated) and `frameForwardLink` (a connected-mode
 * AX.25 link over the box's frame link: its first radio, whose transmissions pass the call gate, or an AXUDP
 * port). `startForwarder` wires them together from env. The message store stays in the cloud; the RF session
 * runs here (ingest-locality).
 *
 * A connect script (`C NODE1` → `C 3 DB0XYZ`) connects to its first hop and sequences the rest; AXUDP partners
 * are validate-at-deploy. A session that fails to connect, at any hop, releases its link, timers and socket.
 */
import type { FrameLink } from "./link.js";
import { TokenBucket } from "./txlimit.js";
import { gatewayFetch } from "./gatewayauth.js";
import { ConnectedLink, decodeFrame, parseAddr, type Ax25Frame, type LinkState } from "@aprscaching/ax25";
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
    const r = await gatewayFetch(`${this.base}/api/bbs/partners`, { headers: { "x-ingest-secret": this.secret } });
    return ((await r.json()) as { partners?: GwPartner[] }).partners ?? [];
  }
  async pool(call: string): Promise<FbbMessage[]> {
    const r = await gatewayFetch(`${this.base}/api/bbs/forward/pool?partner=${encodeURIComponent(call)}`, {
      headers: { "x-ingest-secret": this.secret },
    });
    return ((await r.json()) as { messages?: FbbMessage[] }).messages ?? [];
  }
  async inbound(message: FbbMessage, origin: string): Promise<void> {
    await gatewayFetch(`${this.base}/api/bbs/forward/inbound`, {
      method: "POST",
      headers: this.h(),
      body: JSON.stringify({ message, origin }),
    });
  }
  async markSent(partner: string, bids: string[]): Promise<void> {
    if (!bids.length) return;
    await gatewayFetch(`${this.base}/api/bbs/forward/sent`, {
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
      const r = await gatewayFetch(`${base}/api/bbs/session?call=${encodeURIComponent(call)}`, {
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
      const r = await gatewayFetch(`${base}/api/bbs/messages`, {
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
      await gatewayFetch(`${base}/api/bbs/messages/${id}/read`, { method: "POST", headers: h() });
    },
    kill: async (id, call) => {
      await gatewayFetch(`${base}/api/bbs/kill`, { method: "POST", headers: h(), body: JSON.stringify({ id, call }) });
    },
  };
}

/**
 * The forwarding session gate. Pacing is per session, never per frame: throttling frames inside an open
 * AX.25 link would stall it into retries and a failed exchange. A partner refused here stays due and is
 * tried again on the next scheduler tick.
 */
export function forwardAdmit(bucket: TokenBucket): (p: GwPartner) => boolean {
  return (p) => {
    if (bucket.take()) return true;
    console.warn("[forward] rate limited — session with %s deferred (next in %s s)", p.call, bucket.waitSec());
    return false;
  };
}

/** Build + start a forwarder from env config (the shared frame link + the gateway pool). */
export function startForwarder(o: {
  base: string;
  secret: string;
  mycall: string;
  /** The frame link shared with the connected stack: the box's first radio, else an AXUDP port. */
  link: FrameLink;
  pollMs?: number;
  sid?: string;
  compress?: boolean; // offer LZHUF-B1 compressed forwarding (engages only when the partner also does)
  /** Session pacing (`BBS_FORWARD_BURST`, `BBS_FORWARD_REFILL_SEC`): each session keys the transmitter. */
  burst?: number;
  refillSec?: number;
}): BbsForwarder {
  const fwd = new BbsForwarder({
    api: new GatewayApi(o.base, o.secret),
    linkFactory: (p) =>
      frameForwardLink(o.link, { mycall: o.mycall, partnerCall: p.call, connectScript: p.connectScript }),
    pollMs: o.pollMs,
    sid: o.sid,
    compress: o.compress,
    admit: forwardAdmit(new TokenBucket({ burst: o.burst ?? 4, refillSec: o.refillSec ?? 300 })),
  });
  fwd.start();
  return fwd;
}

/**
 * A connected-mode link over a shared frame pipe (the KISS TNC or the AXUDP port): the same `ConnectedLink`
 * (AX.25 v2.2) as the KISS variant, but frames ride an already-running `FrameLink` instead of a per-session KISS
 * socket. FBB forwarding over AXUDP and the federation packet pull (fedlink.ts) dial through it. The pipe is shared with the NET/ROM node and session server, so the raw subscription is
 * removed when the session ends — a long-running box must not accumulate dead demux callbacks.
 */
export function frameForwardLink(
  pipe: FrameLink,
  o: { mycall: string; partnerCall: string; connectScript: string; tag?: string },
): ForwardLink {
  const local = parseAddr(o.mycall);
  const steps = parseConnectScript(o.connectScript);
  const firstHop = steps.length ? steps[0]!.call : o.partnerCall;
  const remote = parseAddr(firstHop);

  let sequencing = false;
  let seq: ConnectSequencer | null = null;
  let closed = false;
  let wait: ReturnType<typeof setInterval> | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const dataCbs: ((b: Uint8Array) => void)[] = [];
  const closeCbs: (() => void)[] = [];
  /** Release the poll timer, the connect watchers and the pipe subscription; runs once. */
  const fireClose = () => {
    if (closed) return;
    closed = true;
    clearInterval(poll);
    clearInterval(wait);
    clearTimeout(deadline);
    pipe.offRaw?.(onRaw);
    for (const c of closeCbs.splice(0)) c();
  };
  let hungUp = false;
  /** Send DISC, then release once it has had time to leave. Runs once. */
  const hangUp = () => {
    if (hungUp) return;
    hungUp = true;
    link.disconnect();
    setTimeout(fireClose, 500);
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
    error: (msg: string) => console.error("[%s] %s link error: %s", o.tag ?? "forward", o.partnerCall, msg),
  });
  const poll = setInterval(() => link.poll(), 1000);
  const onRaw = (b: Uint8Array) => {
    const f = decodeFrame(b, link.extended);
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
            onFail: (why) => {
              hangUp();
              reject(new Error(`connect script failed: ${why}`));
            },
          });
          seq.start();
        };
        wait = setInterval(() => {
          if (link.state === "connected") {
            clearInterval(wait);
            clearTimeout(deadline); // the hops past the first are bounded by the scheduler's connect timeout
            settle();
          }
        }, 200);
        deadline = setTimeout(() => {
          clearInterval(wait);
          if (link.state !== "connected") {
            hangUp();
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
    disconnect: hangUp,
  };
}
