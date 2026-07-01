/**
 * forwarder.ts — the FBB forwarding scheduler (docs/29 F4), operator-local in `apps/ingest`. On an
 * interval it asks the gateway for its configured forwarding partners, decides which are due now
 * (interval + UTC time-bands, `partnerDue`), and for each opens a connected-mode session to that BBS,
 * runs the pure FBB session codec (`FbbForwarder`) over the link, and bridges the gateway's message
 * store: pull outbound from `/api/bbs/forward/pool`, push inbound to `/inbound`, mark forwarded to
 * `/sent`. The message store stays in the cloud; the RF session runs here (ingest-locality).
 *
 * The connected-mode link is injectable (`linkFactory`) so the codec + scheduler are exercised without
 * a radio; the default `kissForwardLink` drives a real `ConnectedLink` over KISS-TCP. Multi-hop connect
 * scripts (`C NODE1` → `C 3 DB0XYZ`) and AXUDP partners are validate-at-deploy — the default link does a
 * single direct connect to the partner call and logs the script for the operator.
 */
import net from "node:net";
import { kissWrap, kissFrames } from "@aprsweb/aprs";
import { ConnectedLink, encodeFrame, decodeFrame, parseAddr, type Ax25Frame, type LinkState } from "@aprsweb/ax25";
import { FbbForwarder, partnerDue, type FbbMessage, type FbbStore } from "@aprsweb/packet";

/** A forwarding partner as returned by the gateway `/api/bbs/partners`. */
export interface GwPartner {
  id: number; call: string; ha: string | null; connectScript: string;
  proto: "rf-fbb" | "axudp" | "ip-fed"; intervalMin: number; timebands: string;
  requestReverse: boolean; msgtypes: string; maxBlock: number; enabled: boolean;
}

/** A connected-mode byte duplex to a partner: connect, exchange bytes, close. */
export interface ForwardLink {
  connect(): Promise<void>;
  send(bytes: Uint8Array): void;
  onData(cb: (bytes: Uint8Array) => void): void;
  onClose(cb: () => void): void;
  disconnect(): void;
}
export type LinkFactory = (partner: GwPartner) => ForwardLink;

const SESSION_TIMEOUT_MS = 120_000;

/** The gateway REST client for the forwarding pool (all endpoints x-ingest-secret gated). */
class GatewayApi {
  constructor(private base: string, private secret: string) {}
  private h() { return { "content-type": "application/json", "x-ingest-secret": this.secret }; }
  async partners(): Promise<GwPartner[]> {
    const r = await fetch(`${this.base}/api/bbs/partners`);
    return ((await r.json()) as { partners?: GwPartner[] }).partners ?? [];
  }
  async pool(call: string): Promise<FbbMessage[]> {
    const r = await fetch(`${this.base}/api/bbs/forward/pool?partner=${encodeURIComponent(call)}`, { headers: { "x-ingest-secret": this.secret } });
    return ((await r.json()) as { messages?: FbbMessage[] }).messages ?? [];
  }
  async inbound(message: FbbMessage, origin: string): Promise<void> {
    await fetch(`${this.base}/api/bbs/forward/inbound`, { method: "POST", headers: this.h(), body: JSON.stringify({ message, origin }) });
  }
  async markSent(partner: string, bids: string[]): Promise<void> {
    if (!bids.length) return;
    await fetch(`${this.base}/api/bbs/forward/sent`, { method: "POST", headers: this.h(), body: JSON.stringify({ partner, bids }) });
  }
}

/** Per-session FbbStore over a pool snapshot: the outbound queue drains as messages are sent; inbound is
 *  buffered and flushed to the gateway after the session (which dedups by BID). */
class SessionStore implements FbbStore {
  readonly inbox: FbbMessage[] = [];
  readonly sentBids: string[] = [];
  constructor(private queue: FbbMessage[]) {}
  outbound(): FbbMessage[] { return this.queue; }
  hasBid(): boolean { return false; }                 // accept inbound; the gateway INSERT-OR-IGNORE dedups by BID
  accept(m: FbbMessage): void { this.inbox.push(m); }
  sent(bid: string): void {
    this.sentBids.push(bid);
    const i = this.queue.findIndex((q) => q.bid === bid);
    if (i >= 0) this.queue.splice(i, 1);
  }
}

export class BbsForwarder {
  private api: GatewayApi;
  private lastRun = new Map<string, number>();
  private timer?: ReturnType<typeof setInterval>;
  private busy = new Set<string>();
  private linkFactory: LinkFactory;
  private now: () => number;

  constructor(private o: {
    base: string; secret: string; mycall: string; kiss?: { host: string; port: number };
    pollMs?: number; sid?: string; linkFactory?: LinkFactory; now?: () => number;
  }) {
    this.api = new GatewayApi(o.base, o.secret);
    this.now = o.now ?? (() => Math.floor(Date.now() / 1000));
    this.linkFactory = o.linkFactory ?? ((p) => kissForwardLink({
      host: o.kiss!.host, port: o.kiss!.port, mycall: o.mycall, partnerCall: p.call, connectScript: p.connectScript,
    }));
  }

  start(): void {
    this.timer = setInterval(() => { void this.tick(); }, this.o.pollMs ?? 60_000);
    void this.tick();
  }
  stop(): void { if (this.timer) clearInterval(this.timer); }

  /** One scheduler pass: forward every partner that is due now. */
  async tick(): Promise<void> {
    let partners: GwPartner[];
    try { partners = await this.api.partners(); } catch (e) { console.error("[forward] partner poll failed:", (e as Error).message); return; }
    const nowSec = this.now();
    for (const p of partners.filter((x) => x.proto === "rf-fbb" || x.proto === "axudp")) {
      if (this.busy.has(p.call)) continue;
      if (!partnerDue(p, this.lastRun.get(p.call) ?? null, nowSec)) continue;
      this.lastRun.set(p.call, nowSec);
      this.busy.add(p.call);
      try { await this.runSession(p); }
      catch (e) { console.error(`[forward] ${p.call} session failed:`, (e as Error).message); }
      finally { this.busy.delete(p.call); }
    }
  }

  /** Run one FBB forwarding session with a partner and reconcile the results back to the gateway. */
  private async runSession(p: GwPartner): Promise<void> {
    const store = new SessionStore(await this.api.pool(p.call));
    const fwd = new FbbForwarder(store, { initiator: true, sid: this.o.sid });
    const link = this.linkFactory(p);
    await link.connect();

    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => { if (!settled) { settled = true; resolve(); } };
      const timer = setTimeout(() => { link.disconnect(); finish(); }, SESSION_TIMEOUT_MS);
      link.onClose(() => { clearTimeout(timer); finish(); });
      link.onData((bytes) => {
        const out = fwd.onData(bytes);
        if (out) link.send(out);
        if (fwd.done) { clearTimeout(timer); link.disconnect(); finish(); }
      });
      const open = fwd.start();
      if (open) link.send(open);
    });

    for (const m of store.inbox) await this.api.inbound(m, `rf-fbb:${p.call}`);
    await this.api.markSent(p.call, store.sentBids);
    console.log(`[forward] ${p.call}: forwarded ${store.sentBids.length}, received ${store.inbox.length}`);
  }
}

/**
 * A connected-mode FBB link over KISS-TCP: a raw-frame KISS socket driving a `ConnectedLink` (AX.25 v2.2)
 * to the partner. Direct single-hop connect; the multi-hop connect script is logged (validate-at-deploy).
 */
export function kissForwardLink(o: { host: string; port: number; mycall: string; partnerCall: string; connectScript: string }): ForwardLink {
  const local = parseAddr(o.mycall);
  const remote = parseAddr(o.partnerCall);
  if (o.connectScript.trim()) console.log(`[forward] ${o.partnerCall}: connect script (manual/validate-at-deploy): ${o.connectScript.replace(/\n/g, " ; ")}`);

  let sock: net.Socket | null = null;
  let rxBuf: number[] = [];
  const dataCbs: ((b: Uint8Array) => void)[] = [];
  const closeCbs: (() => void)[] = [];
  const fireClose = () => { for (const c of closeCbs.splice(0)) c(); };

  const link = new ConnectedLink(local, remote, {
    send: (f: Ax25Frame) => { try { sock?.write(kissWrap(encodeFrame(f))); } catch { /* link down */ } },
    deliver: (info: Uint8Array) => { for (const c of dataCbs) c(info); },
    state: (s: LinkState) => { if (s === "disconnected") fireClose(); },
    error: (msg: string) => console.error(`[forward] ${o.partnerCall} link error: ${msg}`),
  });
  const poll = setInterval(() => link.poll(), 1000);

  return {
    connect: () => new Promise<void>((resolve, reject) => {
      const s = net.connect(o.port, o.host);
      sock = s;
      s.on("connect", () => link.connect());
      s.on("data", (chunk: Buffer) => {
        for (const b of chunk) rxBuf.push(b);
        const lastFend = rxBuf.lastIndexOf(0xc0);
        if (lastFend <= 0) return;
        const ready = Uint8Array.from(rxBuf.slice(0, lastFend + 1));
        rxBuf = rxBuf.slice(lastFend + 1);
        for (const raw of kissFrames(ready)) { const f = decodeFrame(raw); if (f) link.onReceive(f); }
      });
      s.on("error", (e) => reject(e));
      s.on("close", () => { clearInterval(poll); fireClose(); });
      // resolve once the AX.25 link reaches "connected"
      const wait = setInterval(() => { if (link.state === "connected") { clearInterval(wait); resolve(); }
        else if (link.state === "disconnected" && sock) { /* still dialing TCP or refused */ } }, 200);
      setTimeout(() => { clearInterval(wait); if (link.state !== "connected") reject(new Error("connect timeout")); }, 30_000);
    }),
    send: (bytes: Uint8Array) => link.send(bytes),
    onData: (cb) => { dataCbs.push(cb); },
    onClose: (cb) => { closeCbs.push(cb); },
    disconnect: () => { link.disconnect(); setTimeout(() => { clearInterval(poll); sock?.end(); }, 500); },
  };
}
