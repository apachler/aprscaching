// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * fedlink.ts — federation pull over packet circuits, the dialing side. On a timer the box asks its gateway
 * which peers publish an `ax25` or `netrom` endpoint, dials the one waiting longest over the box's own frame
 * link (the KISS TNC, or the AXUDP port), runs the `ACSL1` exchange and hands every page to its gateway's
 * `/federation/frames`, where each frame is checked against its origin's key. Then it reports the session.
 *
 * Airtime is the scarce thing, so the schedule is polite by construction: at most one session per interval
 * and never two at once, a page budget per session, a peer that failed waits a doubling number of rounds, and
 * no dial while the station's transmit switch is off. The box holds no keys and makes no trust decision.
 */
import type { ForwardLink } from "@aprscaching/packet";
import { FedSyncLinkClient } from "@aprscaching/packet";
import { gatewayFetch } from "./gatewayauth.js";
import { dict1Codec, pullFedSync, VHF_COMPACT_CAPS, type FeedCursor } from "./fedsynclink.js";

/** The feeds pulled each session, in the order the HTTP pull applies them: deletes first. */
export const FED_LINK_FEEDS = ["tombstone", "cache", "find", "key", "account-move", "bulletin"] as const;

/** The default interval between pull rounds: one hour. */
export const FED_LINK_PULL_DEFAULT_MS = 60 * 60_000;
/** The shortest interval between pull rounds: every round may key the transmitter. */
export const FED_LINK_PULL_MIN_MS = 60_000;
/** The default page budget of one session: 20 pages of up to 25 records. */
export const FED_LINK_PAGES_DEFAULT = 20;
/** The longest a failed peer waits: 32 rounds. */
const MAX_BACKOFF_ROUNDS = 32;

export interface PacketEndpoint {
  transport: "ax25" | "netrom";
  address: string;
}

/** A peer as the gateway lists it for packet pull. */
export interface PacketPeer {
  instance: string;
  endpoints: PacketEndpoint[];
  cursors: Record<string, FeedCursor>;
}

/** One session's outcome, reported to the gateway. */
export interface PacketReport {
  instance: string;
  transport: PacketEndpoint["transport"];
  address: string;
  ok: boolean;
  error?: string;
  pages: number;
  frames: number;
  applied: number;
  quarantined: number;
  rejected: number;
  /** The feeds the session moved, with their new positions. */
  cursors: Record<string, FeedCursor>;
  /** Every feed reported complete: the peer has nothing more right now. */
  complete: boolean;
}

/** How to reach an endpoint: the circuit to open and, for a node, the command that starts the sync service. */
export interface DialPlan {
  /** The station the circuit ends at: an `ax25` call, or the node alias. */
  target: string;
  /** A connect script through nodes (`C <node>` lines); empty for a direct connect. */
  connectScript: string;
  /** Sent once the circuit is up: `FED` on a node, nothing on a station that answers with the service. */
  command?: string;
}

/**
 * The dial plan for an endpoint, or a reason it cannot be dialled from this box. An `ax25` endpoint is a
 * station that answers with the sync service: connect to it directly. A `netrom` endpoint is a node alias:
 * connect to the entry node (`FED_LINK_NODE`), have it route `C <alias>`, then give the node's `FED` command.
 */
export function dialPlan(e: PacketEndpoint, entryNode: string | undefined): DialPlan | { skip: string } {
  if (e.transport === "ax25") return { target: e.address.toUpperCase(), connectScript: "" };
  if (!entryNode) return { skip: `netrom endpoint ${e.address} needs FED_LINK_NODE, the node to enter through` };
  const alias = e.address.toUpperCase();
  return { target: alias, connectScript: `C ${entryNode.toUpperCase()}\nC ${alias}`, command: "FED" };
}

/** Split circuit bytes into lines on CR or LF; a run of bytes past `max` without one is dropped. */
export class CircuitLines {
  private buf = "";
  private dec = new TextDecoder();
  constructor(private max = 16 * 1024) {}
  push(bytes: Uint8Array): string[] {
    this.buf += this.dec.decode(bytes, { stream: true });
    const parts = this.buf.split(/\r\n|\r|\n/);
    this.buf = parts.pop() ?? "";
    if (this.buf.length > this.max) this.buf = "";
    return parts.filter((l) => l.length > 0);
  }
}

/** Reject after `ms` with `what` timed out; the timer never holds the process open. */
function within<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    t = setTimeout(() => reject(new Error(`${what} timed out`)), ms);
    t.unref?.();
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(t));
}

export interface FedLinkPullerOpts {
  /** The packet peers, longest-waiting first (`GET /federation/packet/peers`). */
  peers(): Promise<PacketPeer[]>;
  /** Record a session (`POST /federation/packet/status`). */
  report(r: PacketReport): Promise<void>;
  /** Open a circuit (not yet connected) to a dial plan's target. */
  dial(plan: DialPlan): ForwardLink;
  /** Our gateway's base URL and credential, where the pages go. */
  gatewayBase: string;
  secret: string;
  fetchFn?: typeof fetch;
  /** The station's transmit switch: no dial while it is off. */
  canTransmit(): boolean;
  /** The node a `netrom` endpoint is entered through. */
  entryNode?: string;
  intervalMs?: number;
  /** Pages one session may pull across all feeds. */
  maxPages?: number;
  /** Waits: the connect (all hops), the greeting, and each page. */
  connectTimeoutMs?: number;
  helloTimeoutMs?: number;
  pageTimeoutMs?: number;
  log?: (msg: string) => void;
}

/** The pull scheduler: one session per round, rotating through the peers, backing off from failing ones. */
export class FedLinkPuller {
  private busy = false;
  private round_ = 0;
  /** instance → its consecutive failures and the round before which it is not dialled again. */
  private backoff = new Map<string, { fails: number; until: number }>();
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(private o: FedLinkPullerOpts) {}

  private log(m: string): void {
    (this.o.log ?? console.log)(`[fedlink] ${m}`);
  }

  /** Run rounds on the interval, the first shortly after start. */
  start(firstAfterMs = 15_000): void {
    const run = () => void this.round().catch((e) => this.log(`round failed: ${(e as Error).message}`));
    setTimeout(run, firstAfterMs).unref?.();
    this.timer = setInterval(run, this.o.intervalMs ?? FED_LINK_PULL_DEFAULT_MS);
  }

  stop(): void {
    clearInterval(this.timer);
  }

  /**
   * One round: pick the first peer that is not backing off and has an endpoint this box can dial, run one
   * session with it, and report. Null when no session ran (busy, transmit off, nothing to dial).
   */
  async round(): Promise<PacketReport | null> {
    if (this.busy) return null;
    this.round_++;
    if (!this.o.canTransmit()) {
      this.log("transmit is switched off; no session this round");
      return null;
    }
    this.busy = true;
    try {
      const peers = await this.o.peers();
      for (const peer of peers) {
        const b = this.backoff.get(peer.instance);
        if (b && this.round_ < b.until) continue;
        let plan: DialPlan | null = null;
        let endpoint: PacketEndpoint | null = null;
        for (const e of peer.endpoints) {
          const p = dialPlan(e, this.o.entryNode);
          if ("skip" in p) {
            this.log(`${peer.instance}: ${p.skip}`);
            continue;
          }
          plan = p;
          endpoint = e;
          break;
        }
        if (!plan || !endpoint) continue;
        const report = await this.session(peer, endpoint, plan);
        if (report.ok) this.backoff.delete(peer.instance);
        else {
          const fails = (b?.fails ?? 0) + 1;
          this.backoff.set(peer.instance, {
            fails,
            until: this.round_ + 1 + Math.min(MAX_BACKOFF_ROUNDS, 2 ** (fails - 1)), // skip 1, 2, 4 … rounds
          });
        }
        await this.o.report(report).catch((e) => this.log(`report failed: ${(e as Error).message}`));
        return report;
      }
      return null;
    } finally {
      this.busy = false;
    }
  }

  /** One circuit: connect, greet, pull each feed within the page budget, hang up. */
  private async session(peer: PacketPeer, e: PacketEndpoint, plan: DialPlan): Promise<PacketReport> {
    const report: PacketReport = {
      instance: peer.instance,
      transport: e.transport,
      address: e.address,
      ok: false,
      pages: 0,
      frames: 0,
      applied: 0,
      quarantined: 0,
      rejected: 0,
      cursors: {},
      complete: false,
    };
    const enc = new TextEncoder();
    const link = this.o.dial(plan);
    const client = new FedSyncLinkClient(
      VHF_COMPACT_CAPS,
      { sendLine: (line) => link.send(enc.encode(line + "\r")) },
      dict1Codec,
    );
    const lines = new CircuitLines();
    link.onData((b) => {
      for (const l of lines.push(b)) client.onLine(l);
    });
    link.onClose(() => client.close("circuit closed"));
    const hello = client.hello();
    hello.catch(() => {}); // a failed connect leaves it unanswered; the session reports the connect error
    this.log(`dialling ${peer.instance} at ${e.transport} ${e.address}`);
    try {
      await within(link.connect(), this.o.connectTimeoutMs ?? 120_000, "connect");
      if (plan.command) link.send(enc.encode(plan.command + "\r"));
      await within(hello, this.o.helloTimeoutMs ?? 60_000, "greeting");
      let budget = this.o.maxPages ?? FED_LINK_PAGES_DEFAULT;
      let complete = true;
      for (const type of FED_LINK_FEEDS) {
        if (budget <= 0) {
          complete = false;
          break;
        }
        const r = await pullFedSync({
          client: {
            pull: (t, since, limit, sinceId) =>
              within(client.pull(t, since, limit, sinceId), this.o.pageTimeoutMs ?? 300_000, "page"),
          },
          gatewayBase: this.o.gatewayBase,
          secret: this.o.secret,
          type,
          cursor: peer.cursors[type],
          maxPages: budget,
          fetchFn: this.o.fetchFn,
        });
        budget -= r.pages;
        report.pages += r.pages;
        report.frames += r.frames;
        report.applied += r.applied;
        report.quarantined += r.quarantined;
        report.rejected += r.rejected;
        report.cursors[type] = r.cursor;
        if (!r.complete) complete = false;
      }
      report.ok = true;
      report.complete = complete;
      this.log(
        `${peer.instance}: ${report.pages} page(s), ${report.frames} record(s), ${report.applied} applied` +
          (complete ? "" : " (more next round)"),
      );
    } catch (err) {
      report.error = (err as Error).message;
      this.log(`${peer.instance} at ${e.transport} ${e.address}: ${report.error}`);
    } finally {
      link.disconnect();
    }
    return report;
  }
}

/** The gateway side of the scheduler: the packet peer list and the session report, both ingest-authenticated. */
export function gatewayPacketApi(
  base: string,
  secret: string,
  fetchFn: typeof fetch = gatewayFetch,
): Pick<FedLinkPullerOpts, "peers" | "report"> {
  return {
    async peers() {
      const r = await fetchFn(`${base}/federation/packet/peers`, { headers: { "x-ingest-secret": secret } });
      if (!r.ok) throw new Error(`gateway packet peers ${r.status}`);
      return ((await r.json()) as { peers?: PacketPeer[] }).peers ?? [];
    },
    async report(rep) {
      const r = await fetchFn(`${base}/federation/packet/status`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-ingest-secret": secret },
        body: JSON.stringify(rep),
      });
      if (!r.ok) throw new Error(`gateway packet status ${r.status}`);
    },
  };
}
