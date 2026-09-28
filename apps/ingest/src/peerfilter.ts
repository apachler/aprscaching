// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * peerfilter.ts — receive-side allowlist for the tunnelled AX.25 ports (AXUDP, AXIP).
 *
 * A port with configured peers feeds the NET/ROM node, the BBS and the ingest, so it accepts frames only
 * from those peers' addresses; everything else is dropped and counted. Peers are named by host, so the
 * names are resolved at start and re-resolved periodically — a peer on dynamic DNS keeps working when its
 * address changes. A failed lookup keeps the addresses resolved last time rather than locking the peer out.
 */
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export type Resolver = (host: string) => Promise<string[]>;

const defaultResolver: Resolver = async (host) => (await lookup(host, { all: true, family: 4 })).map((a) => a.address);

/** `::ffff:192.0.2.1` (an IPv4-mapped address from a dual-stack socket) → `192.0.2.1`. */
export const normalizeAddress = (a: string): string => a.replace(/^::ffff:/i, "");

export interface PeerAllowlistOpts {
  hosts: string[];
  /** Re-resolve interval (default 5 minutes). */
  refreshMs?: number;
  resolve?: Resolver;
  log?: (msg: string) => void;
  /** Tag for log lines, e.g. `axudp`. */
  name: string;
}

export class PeerAllowlist {
  private addrs = new Map<string, Set<string>>(); // host → its current addresses
  private timer?: ReturnType<typeof setInterval>;
  private dropLoggedAt = new Map<string, number>();
  /** Datagrams refused because their source is not a configured peer. */
  dropped = 0;

  constructor(private o: PeerAllowlistOpts) {}

  private get log() {
    return this.o.log ?? ((m: string) => console.warn(m));
  }

  /** Resolve every peer now. Literal addresses need no lookup. */
  async refresh(): Promise<void> {
    const resolve = this.o.resolve ?? defaultResolver;
    await Promise.all(
      this.o.hosts.map(async (host) => {
        if (isIP(host)) {
          this.addrs.set(host, new Set([normalizeAddress(host)]));
          return;
        }
        try {
          const found = await resolve(host);
          if (found.length) this.addrs.set(host, new Set(found.map(normalizeAddress)));
        } catch (e) {
          // keep the last good addresses; a transient DNS failure must not cut a working link
          this.log(`[${this.o.name}] could not resolve peer ${host} (${(e as Error).message})`);
        }
      }),
    );
  }

  async start(): Promise<void> {
    await this.refresh();
    this.timer = setInterval(() => void this.refresh(), this.o.refreshMs ?? 5 * 60_000);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Is `address` one of the peers' current addresses? Counts and (once a minute per source) logs a refusal. */
  allows(address: string | undefined): boolean {
    const a = address ? normalizeAddress(address) : "";
    for (const set of this.addrs.values()) if (set.has(a)) return true;
    this.dropped++;
    const now = Date.now();
    if (now - (this.dropLoggedAt.get(a) ?? 0) > 60_000) {
      this.dropLoggedAt.set(a, now);
      this.log(`[${this.o.name}] dropped a frame from ${a || "an unknown source"} — not a configured peer`);
    }
    return false;
  }
}

/** The one-time warning for a receive-only tunnel port that has no peer list. */
export function openListenerWarning(name: string, bindVar: string, peersVar: string): string {
  return `[${name}] no ${peersVar} configured — accepting tunnelled frames from any host; set ${bindVar} to a LAN address or name the peers in ${peersVar}`;
}
