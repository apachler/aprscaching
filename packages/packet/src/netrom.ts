// SPDX-License-Identifier: MIT
/**
 * netrom.ts — NET/ROM node logic (docs/25 P4): the NODES routing table (learn / best-route / quality
 * decay), reversible learned digi paths (the Graphic Packet autorouting feature — build a return path
 * from a heard one), and the node user CLI (Nodes/Routes/Connect/Users/MHeard/CQ/Bye) a connected
 * session talks to. All pure + unit-tested; the ingest wires the CLI to incoming AX.25 connects and the
 * digipeater to RF (validate-at-deploy). This is the routing/console brain.
 */

export interface NodeRoute { dest: string; alias: string; neighbor: string; quality: number; port?: string }

/** The NODES table: best (highest-quality) route per destination, learned from NODES broadcasts. */
export class NodesTable {
  private byDest = new Map<string, NodeRoute>();
  constructor(seed: NodeRoute[] = []) { for (const r of seed) this.learn(r); }

  /** Learn/replace a route; keep the higher-quality one per destination. */
  learn(r: NodeRoute): void {
    const key = r.dest.toUpperCase();
    const cur = this.byDest.get(key);
    if (!cur || r.quality > cur.quality) this.byDest.set(key, { ...r, dest: key, alias: r.alias.toUpperCase() });
  }
  /** Best route to a destination by callsign OR alias. */
  best(destOrAlias: string): NodeRoute | null {
    const k = destOrAlias.toUpperCase();
    return this.byDest.get(k) ?? [...this.byDest.values()].find((r) => r.alias === k) ?? null;
  }
  list(): NodeRoute[] { return [...this.byDest.values()].sort((a, b) => b.quality - a.quality); }
  /** Age every route's quality (NET/ROM obsolescence); drop routes that fall to 0. */
  decay(factor = 0.9): void {
    for (const [k, r] of this.byDest) { const q = Math.floor(r.quality * factor); if (q <= 0) this.byDest.delete(k); else r.quality = q; }
  }
}

/**
 * Reverse a heard digipeater path into a return path (GP's reversible learned paths). Strips the
 * has-been-repeated '*' markers and reverses the order, so a reply walks back the way the frame came.
 */
export function reversePath(path: string[]): string[] {
  return path.map((p) => p.replace(/\*$/, "").toUpperCase()).filter(Boolean).reverse();
}

// ---- node user CLI ----
export interface NodeUser { call: string; via?: string }
export interface NodeMheard { call: string; port: string; lastHeard: number }
export interface NodeStore {
  nodes(): { alias: string; call: string; quality: number }[];
  routes(): { neighbor: string; port: string; quality: number }[];
  users(): NodeUser[];
  mheard(): NodeMheard[];
  info(): string;
}

const pad = (s: string, n: number) => (s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length));

export class NodeSession {
  private expert = false;
  readonly call: string;
  constructor(callsign: string, private store: NodeStore, private nodeAlias = "NODE", private nodeCall = "N0CALL-1") {
    this.call = callsign.toUpperCase();
  }

  greeting(): string[] {
    return [`${this.nodeCall}:${this.nodeAlias} - APRScaching NET/ROM node`, `Welcome ${this.call}. ? for help.`, this.prompt()];
  }
  private prompt(): string { return this.expert ? `${this.nodeAlias}>` : `${this.call} de ${this.nodeAlias}>`; }
  private out(...lines: string[]): { lines: string[]; connect?: string; disconnect?: boolean } { return { lines: [...lines, this.prompt()] }; }

  /** Process one input line; may return a connect target or a disconnect. */
  handle(input: string): { lines: string[]; connect?: string; disconnect?: boolean } {
    const [wRaw, ...rest] = input.trim().split(/\s+/);
    const w = (wRaw ?? "").toUpperCase(); const arg = rest.join(" ");
    if (!w) return { lines: [this.prompt()] };
    switch (w) {
      case "B": case "BYE": case "Q": return { lines: [`73 de ${this.nodeAlias}`], disconnect: true };
      case "?": case "H": case "HELP": return this.out("Nodes  Routes  Connect <call>  Users  MHeard  CQ <msg>  Info  Bye");
      case "X": this.expert = !this.expert; return this.out(`Expert ${this.expert ? "on" : "off"}.`);
      case "I": case "INFO": return this.out(this.store.info());
      case "N": case "NODES": {
        const ns = this.store.nodes();
        if (arg) { const hit = ns.find((n) => n.alias === arg.toUpperCase() || n.call === arg.toUpperCase()); return this.out(hit ? `${hit.alias}:${hit.call}  quality ${hit.quality}` : `No node "${arg}".`); }
        return this.out(`Nodes (${ns.length}):`, ...ns.map((n) => `${pad(`${n.alias}:${n.call}`, 18)} ${n.quality}`));
      }
      case "R": case "ROUTES": {
        const rs = this.store.routes();
        return this.out(`Routes (${rs.length}):`, ...rs.map((r) => `${pad(r.neighbor, 10)} ${pad(r.port, 8)} ${r.quality}`));
      }
      case "U": case "USERS": {
        const us = this.store.users();
        return this.out(`Users (${us.length}):`, ...us.map((u) => `${u.call}${u.via ? ` via ${u.via}` : ""}`));
      }
      case "MH": case "MHEARD": {
        const mh = this.store.mheard();
        return this.out(`Heard (${mh.length}):`, ...mh.map((m) => `${pad(m.call, 10)} ${m.port}`));
      }
      case "C": case "CONNECT": {
        if (!arg) return this.out("Usage: C <call|alias>");
        return { lines: [`Connecting to ${arg.toUpperCase()}...`], connect: arg.toUpperCase() };
      }
      case "CQ": return this.out(`CQ de ${this.call}: ${arg}`);
      default: return this.out(`Invalid command "${w}". ? for help.`);
    }
  }
}
