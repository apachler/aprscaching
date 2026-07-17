// SPDX-License-Identifier: MIT
/**
 * node-personalities.ts — selectable command surfaces for the node, over ONE routing brain. Packet
 * operators grew up on different node families, and muscle memory is real: a FlexNet user types `D`
 * and expects a destination table with round-trip times; a TheNetNode user gets German-flavoured
 * command words; a BayCom user expects a terse minimal box. Each personality is a `LineApp` over the
 * same injected `NodeStore` — the NODES table, routes, users, and MHeard are shared state; only the
 * conversation differs. The default personality is the native NET/ROM(BPQ-style) `NodeSession`.
 *
 * FlexNet displays a round-trip-time metric where NET/ROM keeps a 0–255 quality: the surface derives
 * a presentation RTT from quality (best quality → lowest RTT, in 100 ms units as FlexNet shows it).
 * A presentation mapping only — routing decisions stay on the native quality metric.
 */
import { NodeSession, type NodeStore } from "./netrom.js";
import type { LineApp, LineReply } from "./link-app.js";

export type NodePersonality = "netrom" | "flexnet" | "tnn" | "baycom";
export const NODE_PERSONALITIES: readonly NodePersonality[] = ["netrom", "flexnet", "tnn", "baycom"];

const pad = (s: string, n: number) => (s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length));

/** FlexNet's displayed RTT (100 ms units) from a NET/ROM quality: best (255) → 1, worst (1) → ~64. */
export function qualityToRtt(quality: number): number {
  const q = Math.min(255, Math.max(1, Math.floor(quality)));
  return Math.max(1, Math.round((256 - q) / 4));
}

function splitCmd(input: string): { w: string; arg: string } {
  const [wRaw, ...rest] = input.trim().split(/\s+/);
  return { w: (wRaw ?? "").toUpperCase(), arg: rest.join(" ") };
}

/** FlexNet-style surface: single-letter commands, destinations with RTT, `=>` prompt. */
class FlexnetSession implements LineApp {
  constructor(
    private readonly call: string,
    private readonly store: NodeStore,
    private readonly alias: string,
    private readonly nodeCall: string,
  ) {}
  greeting(): string[] {
    return [`PC/FlexNet style node ${this.nodeCall} (${this.alias})`, "=>"];
  }
  private out(...lines: string[]): LineReply {
    return { lines: [...lines, "=>"] };
  }
  handle(input: string): LineReply {
    const { w, arg } = splitCmd(input);
    if (!w) return { lines: ["=>"] };
    switch (w) {
      case "Q":
      case "QUIT":
        return { lines: ["73!"], disconnect: true };
      case "H":
      case "?":
        return this.out("C call  D [call]  L  MH  U  I  H  Q");
      case "I":
        return this.out(this.store.info());
      case "D": {
        // the FlexNet signature: reachable destinations with their RTT, packed several per line
        const ds = this.store.nodes().map((n) => `${n.call} ${qualityToRtt(n.quality)}`);
        if (arg) {
          const hit = this.store.nodes().find((n) => n.call === arg.toUpperCase() || n.alias === arg.toUpperCase());
          return this.out(hit ? `${hit.call} rtt ${qualityToRtt(hit.quality)}` : `${arg.toUpperCase()} not found`);
        }
        const rows: string[] = [];
        for (let i = 0; i < ds.length; i += 4)
          rows.push(
            ds
              .slice(i, i + 4)
              .map((d) => pad(d, 18))
              .join(""),
          );
        return this.out(`Destinations (${ds.length}):`, ...rows);
      }
      case "L": {
        const rs = this.store.routes();
        return this.out(
          `Links:`,
          ...rs.map((r) => `${pad(r.neighbor, 10)} ${pad(r.port, 8)} rtt ${qualityToRtt(r.quality)}`),
        );
      }
      case "MH":
        return this.out(...this.store.mheard().map((m) => `${pad(m.call, 10)} ${m.port}`));
      case "U":
        return this.out(...this.store.users().map((u) => u.call));
      case "C": {
        if (!arg) return this.out("C <call>");
        return { lines: [`link setup ${arg.toUpperCase()}...`], connect: arg.toUpperCase() };
      }
      default:
        return this.out("?? H for help");
    }
  }
}

/** TheNetNode-style surface: the TNN command words with German-flavoured labels. */
class TnnSession implements LineApp {
  constructor(
    private readonly call: string,
    private readonly store: NodeStore,
    private readonly alias: string,
    private readonly nodeCall: string,
  ) {}
  greeting(): string[] {
    return [`${this.alias}:${this.nodeCall} TheNetNode`, `Hallo ${this.call}. H = Hilfe.`, this.prompt()];
  }
  private prompt(): string {
    return `${this.alias}>`;
  }
  private out(...lines: string[]): LineReply {
    return { lines: [...lines, this.prompt()] };
  }
  handle(input: string): LineReply {
    const { w, arg } = splitCmd(input);
    if (!w) return { lines: [this.prompt()] };
    switch (w) {
      case "Q":
      case "QUIT":
      case "B":
        return { lines: ["73!"], disconnect: true };
      case "H":
      case "HILFE":
      case "?":
        return this.out("Connect Info Links MHeard Nodes Routes Users Quit  (H <cmd> = Hilfe)");
      case "I":
      case "INFO":
        return this.out(this.store.info());
      case "N":
      case "NODES": {
        const ns = this.store.nodes();
        return this.out(
          `Bekannte Nodes (${ns.length}):`,
          ...ns.map((n) => `${pad(`${n.alias}:${n.call}`, 18)} ${n.quality}`),
        );
      }
      case "L":
      case "LINKS": {
        const rs = this.store.routes();
        return this.out(
          `Links (${rs.length}):`,
          ...rs.map((r) => `${pad(r.neighbor, 10)} ${pad(r.port, 8)} ${r.quality}`),
        );
      }
      case "R":
      case "ROUTES":
        return this.handle("LINKS");
      case "MH":
      case "MHEARD":
        return this.out(
          `Gehoert (${this.store.mheard().length}):`,
          ...this.store.mheard().map((m) => `${pad(m.call, 10)} ${m.port}`),
        );
      case "U":
      case "USERS":
        return this.out(`Benutzer (${this.store.users().length}):`, ...this.store.users().map((u) => u.call));
      case "C":
      case "CONNECT": {
        if (!arg) return this.out("Connect <Rufzeichen>");
        return { lines: [`Verbinde zu ${arg.toUpperCase()}...`], connect: arg.toUpperCase() };
      }
      default:
        return this.out(`Unbekanntes Kommando "${w}". H = Hilfe.`);
    }
  }
}

/** BayCom-style surface: the terse minimal box (`>` prompt, single-letter essentials). */
class BaycomSession implements LineApp {
  constructor(
    private readonly call: string,
    private readonly store: NodeStore,
    private readonly nodeCall: string,
  ) {}
  greeting(): string[] {
    return [`*** ${this.nodeCall} BayCom-style node`, ">"];
  }
  private out(...lines: string[]): LineReply {
    return { lines: [...lines, ">"] };
  }
  handle(input: string): LineReply {
    const { w, arg } = splitCmd(input);
    if (!w) return { lines: [">"] };
    switch (w) {
      case "Q":
        return { lines: ["*** bye"], disconnect: true };
      case "H":
      case "?":
        return this.out("C I M U Q");
      case "I":
        return this.out(this.store.info());
      case "M":
        return this.out(...this.store.mheard().map((m) => `${pad(m.call, 10)} ${m.port}`));
      case "U":
        return this.out(...this.store.users().map((u) => u.call));
      case "C": {
        if (!arg) return this.out("C <call>");
        return { lines: [`*** link ${arg.toUpperCase()}`], connect: arg.toUpperCase() };
      }
      default:
        return this.out("?");
    }
  }
}

/** Build the node CLI in the operator's chosen personality; unknown values fall back to native. */
export function makeNodeSession(
  personality: string | undefined,
  callsign: string,
  store: NodeStore,
  alias: string,
  nodeCall: string,
): LineApp {
  switch ((personality ?? "netrom").toLowerCase()) {
    case "flexnet":
      return new FlexnetSession(callsign.toUpperCase(), store, alias, nodeCall);
    case "tnn":
      return new TnnSession(callsign.toUpperCase(), store, alias, nodeCall);
    case "baycom":
      return new BaycomSession(callsign.toUpperCase(), store, nodeCall);
    default:
      return new NodeSession(callsign, store, alias, nodeCall);
  }
}
