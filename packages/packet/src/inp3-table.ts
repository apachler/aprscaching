// SPDX-License-Identifier: MIT
/**
 * inp3-table.ts — the INP3 routing table: best (lowest round-trip-time) route per destination,
 * learned from neighbours' Routing Information Frames, with triggered-update tracking and horizon
 * enforcement. INP3 ranks by measured `tt` (transport time, lower is better) instead of NET/ROM's
 * 0–255 quality, and propagates changes as they happen (dirty flags) rather than on a fixed
 * broadcast clock — so it converges faster than classic NODES flooding.
 *
 * Pure, zero-I/O; inp3-node.ts binds this to the RIF/L3RTT codec and the link.
 */
import { INP_MAX_HOPS, INP_TT_WITHDRAW, type Rip } from "./inp3.js";

export interface Inp3Route {
  dest: string; // destination callsign (uppercased)
  alias: string;
  neighbor: string; // the neighbour we learnt it from (next hop)
  tt: number; // round-trip transport time, 10 ms units — lower is better
  hops: number;
  ip?: { addr: [number, number, number, number]; bits: number };
  dirty: boolean; // changed since the last update we sent → include in the next triggered RIF
}

export class Inp3Table {
  private byDest = new Map<string, Inp3Route>();

  /**
   * Apply one RIP learnt from `neighbor` over a link whose own tt to that neighbour is `linkTt`.
   * Returns the resulting change: "added" | "updated" | "withdrawn" | "ignored". A route that
   * changes the best path is marked dirty for the next triggered update.
   */
  applyRip(rip: Rip, neighbor: string, linkTt: number): "added" | "updated" | "withdrawn" | "ignored" {
    const key = rip.dest.call.toUpperCase() + (rip.dest.ssid ? `-${rip.dest.ssid}` : "");
    const nb = neighbor.toUpperCase();
    const cur = this.byDest.get(key);

    // A withdrawal (tt = 60000) removes the route IF it came from the neighbour we're using for it.
    if (rip.tt >= INP_TT_WITHDRAW) {
      if (cur && cur.neighbor === nb) {
        this.byDest.delete(key);
        return "withdrawn";
      }
      return "ignored";
    }

    const hops = rip.hops + 1;
    if (hops > INP_MAX_HOPS) return "ignored"; // beyond the horizon — never add

    const tt = rip.tt + linkTt; // our tt to the destination = the neighbour's tt + our tt to the neighbour
    const route: Inp3Route = {
      dest: key,
      alias: (rip.alias ?? cur?.alias ?? "").toUpperCase(),
      neighbor: nb,
      tt,
      hops,
      ip: rip.ip ?? cur?.ip,
      dirty: true,
    };

    if (!cur) {
      this.byDest.set(key, route);
      return "added";
    }
    // Update if this is a better (lower-tt) path, OR a refresh of the path we're already using.
    if (tt < cur.tt || cur.neighbor === nb) {
      // no real change → don't dirty (avoids update storms on periodic refresh of an identical route)
      const changed = cur.neighbor !== nb || cur.tt !== tt || cur.hops !== hops;
      route.dirty = changed;
      this.byDest.set(key, route);
      return changed ? "updated" : "ignored";
    }
    return "ignored";
  }

  /** Best (lowest-tt) route to a destination by callsign or alias. */
  best(destOrAlias: string): Inp3Route | null {
    const k = destOrAlias.toUpperCase();
    return this.byDest.get(k) ?? [...this.byDest.values()].find((r) => r.alias === k) ?? null;
  }

  /** All routes, best (lowest tt) first. */
  list(): Inp3Route[] {
    return [...this.byDest.values()].sort((a, b) => a.tt - b.tt);
  }

  /** The routes changed since the last drain, as RIPs to advertise; clears the dirty flags. */
  drainDirty(): Rip[] {
    const out: Rip[] = [];
    for (const r of this.byDest.values()) {
      if (!r.dirty) continue;
      r.dirty = false;
      out.push(this.toRip(r));
    }
    return out;
  }

  /** Every route as a RIP (for a periodic full advertisement); does not touch the dirty flags. */
  snapshot(): Rip[] {
    return [...this.byDest.values()].map((r) => this.toRip(r));
  }

  private toRip(r: Inp3Route): Rip {
    return { dest: parseCall(r.dest), hops: r.hops, tt: r.tt, alias: r.alias || undefined, ip: r.ip };
  }

  /**
   * Age routes: a route unheard for longer than its neighbour's refresh window is withdrawn. INP3
   * ages by staleness rather than NET/ROM quality decay; `stale(dest)` returns the withdrawn dests
   * so the caller can advertise their withdrawal.
   */
  expire(shouldExpire: (r: Inp3Route) => boolean): string[] {
    const gone: string[] = [];
    for (const [k, r] of this.byDest) {
      if (shouldExpire(r)) {
        this.byDest.delete(k);
        gone.push(k);
      }
    }
    return gone;
  }
}

function parseCall(s: string): { call: string; ssid: number } {
  const [call, ssid] = s.split("-");
  return { call: call!, ssid: ssid ? Number(ssid) : 0 };
}
