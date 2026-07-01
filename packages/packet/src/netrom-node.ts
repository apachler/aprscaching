/**
 * netrom-node.ts — the NET/ROM node routing engine (docs/29 F2), from the open NET/ROM spec's
 * "Automatic Routing Table Updates". Maintains learned routes from heard NODES broadcasts, builds our
 * own periodic NODES broadcast, and picks the best next hop for a connect-through. Pure — the ingest
 * (`apps/ingest/src/netromnode.ts`) wires it to KISS: periodic UI-to-"NODES" TX + inbound consume + the
 * L4 circuit (netrom-circuit.ts) that carries a connect through the chosen neighbour.
 *
 * Route quality = combineQuality(advertised, pathToNeighbour). Each learned route carries an obsolescence
 * count (init 6, refreshed when re-heard, decremented on decay, dropped at 0; locked routes never decay),
 * and broadcasts advertise our best routes (top-N by quality), matching BPQ/NET-ROM behaviour.
 */
import { encodeNodesBroadcast, decodeNodesBroadcast, combineQuality, type NodesDest } from "./netrom-wire.js";
import { addrStr, type Ax25Address } from "@aprsweb/ax25";

export interface NodeIdent { call: Ax25Address; alias: string }
export interface LearnedRoute {
  dest: Ax25Address; alias: string; neighbor: Ax25Address; quality: number;
  port?: string; obsolescence: number; locked: boolean;
}

const OBS_INIT = 6;                 // NET/ROM initial obsolescence count
const DEFAULT_PATH_QUALITY = 192;   // link quality assumed for a directly-heard neighbour
const DEFAULT_TOP_N = 3;            // best routes we re-advertise

export class NetromNode {
  private routes = new Map<string, LearnedRoute>();   // key = dest call-ssid
  constructor(private ident: NodeIdent, private opts: { pathQuality?: number; topN?: number } = {}) {}

  private key(a: Ax25Address): string { return addrStr(a).toUpperCase(); }

  /** Learn/refresh a route, keeping the higher-quality one and refreshing obsolescence. */
  private learn(r: Omit<LearnedRoute, "obsolescence" | "locked"> & { locked?: boolean }): void {
    const k = this.key(r.dest);
    const cur = this.routes.get(k);
    if (!cur || r.quality >= cur.quality) {
      this.routes.set(k, { ...r, alias: r.alias.toUpperCase(), obsolescence: OBS_INIT, locked: r.locked ?? cur?.locked ?? false });
    } else if (cur) {
      cur.obsolescence = OBS_INIT;                    // still heard → refresh even if we keep the better route
    }
  }

  /** Pin a route so it survives decay (a manually-configured neighbour link). */
  lock(r: { dest: Ax25Address; alias: string; neighbor: Ax25Address; quality: number; port?: string }): void {
    this.learn({ ...r, locked: true });
  }

  /**
   * Consume a heard NODES broadcast from `neighbor` (heard on `port`): the neighbour itself becomes
   * directly reachable at the path quality, and each advertised destination becomes reachable *via* the
   * neighbour at combineQuality(advertised, path). Returns the number of routes learned/refreshed.
   */
  consume(info: Uint8Array, neighbor: Ax25Address, port?: string): number {
    const decoded = decodeNodesBroadcast(info);
    if (!decoded) return 0;
    const path = this.opts.pathQuality ?? DEFAULT_PATH_QUALITY;
    let n = 0;
    // the neighbour is a direct route at path quality
    this.learn({ dest: neighbor, alias: decoded.senderAlias || addrStr(neighbor), neighbor, quality: path, port }); n++;
    for (const d of decoded.dests) {
      if (this.key(d.dest) === this.key(this.ident.call)) continue;   // never learn a route to ourself
      this.learn({ dest: d.dest, alias: d.alias, neighbor, quality: combineQuality(d.quality, path), port }); n++;
    }
    return n;
  }

  /** Best route to a destination by callsign OR alias (highest quality wins). */
  best(destOrAlias: string): LearnedRoute | null {
    const k = destOrAlias.toUpperCase();
    const direct = this.routes.get(k);
    if (direct) return direct;
    const byAlias = [...this.routes.values()].filter((r) => r.alias === k).sort((a, b) => b.quality - a.quality);
    return byAlias[0] ?? null;
  }

  list(): LearnedRoute[] { return [...this.routes.values()].sort((a, b) => b.quality - a.quality); }

  /**
   * Build our NODES broadcast frames: advertise ourself (dest = our call, neighbour = our call, quality 0
   * so the receiver substitutes its own path quality) plus our top-N best routes. Chunked to ≤11/frame.
   */
  broadcast(): Uint8Array[] {
    const topN = this.opts.topN ?? DEFAULT_TOP_N;
    const self: NodesDest = { dest: this.ident.call, alias: this.ident.alias, neighbor: this.ident.call, quality: 0 };
    const best = this.list().filter((r) => r.obsolescence > 0).slice(0, topN)
      .map<NodesDest>((r) => ({ dest: r.dest, alias: r.alias, neighbor: r.neighbor, quality: r.quality }));
    return encodeNodesBroadcast(this.ident.alias, [self, ...best]);
  }

  /** Age every unlocked route's obsolescence; drop routes that reach 0 (NET/ROM obsolescence). */
  decay(): void {
    for (const [k, r] of this.routes) {
      if (r.locked) continue;
      if (--r.obsolescence <= 0) this.routes.delete(k);
    }
  }
}
