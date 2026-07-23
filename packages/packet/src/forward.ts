// SPDX-License-Identifier: MIT
/**
 * forward.ts — FBB hierarchical addressing + forward routing + the proposal/accept protocol (
 * P3). Pure + unit-tested: the parser turns an FBB H-address ("TO @ BBS.#REGION.STATE.COUNTRY.CONT.WW")
 * into components, the router does longest-/most-specific-prefix matching against a forward table to
 * pick a partner, and the proposal codec builds the "FB …" proposal block + parses the "FS …" reply.
 * The actual partner *link* (and LZHUF B1/B2 compression) is validate-at-deploy; this is the routing
 * brain the gateway/ingest drive.
 */

export interface HierAddr {
  to: string;
  bbs: string | null;
  hier: string[];
}

/** Parse "TO @ BBS.#OE3.OE.EU" (or just "TO") into its routing components. */
export function parseHierAddr(addr: string): HierAddr {
  const [left, right] = addr.split("@").map((s) => s.trim());
  const to = (left ?? "").toUpperCase();
  if (!right) return { to, bbs: null, hier: [] };
  const parts = right
    .toUpperCase()
    .split(".")
    .map((p) => p.trim())
    .filter(Boolean);
  return { to, bbs: parts[0] ?? null, hier: parts.slice(1) };
}

/** The ordered specificity list for an address: bbs first (most specific) → continent/WW last. */
function specificity(addr: HierAddr): string[] {
  return [addr.bbs, ...addr.hier].filter((x): x is string => !!x);
}

export interface ForwardRule {
  partner: string;
  route: string;
  transport?: string;
}

/**
 * Route a hierarchical address to a partner. A rule matches if its `route` token appears among the
 * address components (bbs + hierarchy). The most specific match wins (lowest index in the specificity
 * list); ties break to the longer route token. Returns null when no rule matches.
 */
export class ForwardRouter {
  private rules: ForwardRule[];
  constructor(rules: ForwardRule[] = []) {
    this.rules = rules.map((r) => ({ ...r, route: r.route.toUpperCase() }));
  }

  route(addr: HierAddr): ForwardRule | null {
    const spec = specificity(addr);
    let best: ForwardRule | null = null,
      bestIdx = Infinity,
      bestLen = 0,
      fallback: ForwardRule | null = null;
    for (const r of this.rules) {
      if (r.route === "*") {
        fallback = fallback ?? r;
        continue;
      } // catch-all, lowest priority
      const idx = spec.indexOf(r.route);
      if (idx < 0) continue;
      if (idx < bestIdx || (idx === bestIdx && r.route.length > bestLen)) {
        best = r;
        bestIdx = idx;
        bestLen = r.route.length;
      }
    }
    return best ?? fallback;
  }
}

// ---- FBB forward proposal/accept protocol (the F> / FS handshake) ----
export interface Proposal {
  type: "P" | "B" | "T";
  from: string;
  to: string;
  atBbs: string;
  bid: string;
  size: number;
}

/**
 * Build the proposal block a sender offers: one line per message then "F>". The FBB field order is
 * `FB <type> <FROM> <@AT> <TO> <BID> <size>` (7 fields incl. FB) — the @AT is the recipient's home BBS.
 */
export function buildProposal(msgs: Proposal[]): string[] {
  const lines = msgs.map((m) => `FB ${m.type} ${m.from} ${m.atBbs} ${m.to} ${m.bid} ${m.size}`);
  lines.push("F>");
  return lines;
}

/** Build a compressed-forwarding proposal block: `FA` instead of `FB`, same field order, then "F>". */
export function buildProposalFA(msgs: Proposal[]): string[] {
  const lines = msgs.map((m) => `FA ${m.type} ${m.from} ${m.atBbs} ${m.to} ${m.bid} ${m.size}`);
  lines.push("F>");
  return lines;
}

/**
 * Parse one proposal line. Accepts both the ASCII `FB` and the compressed `FA` command (7 fields incl.
 * the command). Returns null if malformed. The command is not retained — the session tracks the mode.
 */
export function parseProposal(line: string): Proposal | null {
  const f = line.trim().split(/\s+/);
  if (f.length !== 7 || (f[0] !== "FB" && f[0] !== "FA")) return null;
  const type = f[1] as Proposal["type"];
  if (type !== "P" && type !== "B" && type !== "T") return null;
  const size = Number(f[6]);
  if (!Number.isFinite(size)) return null;
  return { type, from: f[2]!.toUpperCase(), atBbs: f[3]!.toUpperCase(), to: f[4]!.toUpperCase(), bid: f[5]!, size };
}

/** A single FS verdict, with the resume byte offset when the receiver answered `!<offset>`. */
export interface FsVerdict {
  verdict: "accept" | "reject" | "defer";
  offset?: number; // set only for an accept that resumes a partially-held message (`!<offset>`)
}

/**
 * Parse the receiver's "FS ……" reply into per-proposal verdicts, in order:
 *   '+'/'Y' accept · '-'/'N' reject (have it) · '=' /'L' defer · '!<n>' accept + resume from byte n.
 * `!` consumes the decimal offset that follows it, so a multi-message reply like `FS +!512-` is three
 * verdicts (accept · resume@512 · reject). Anything else is treated as reject.
 */
export function parseFSDetailed(line: string): FsVerdict[] {
  const m = /^FS\s*(.*)$/i.exec(line.trim());
  if (!m) return [];
  const s = (m[1] ?? "").replace(/\s+/g, "");
  const out: FsVerdict[] = [];
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c === "!") {
      let j = i + 1;
      while (j < s.length && s[j]! >= "0" && s[j]! <= "9") j++;
      out.push({ verdict: "accept", offset: Number(s.slice(i + 1, j)) || 0 });
      i = j - 1;
    } else if (c === "+" || c === "Y") out.push({ verdict: "accept" });
    else if (c === "=" || c === "L") out.push({ verdict: "defer" });
    else out.push({ verdict: "reject" });
  }
  return out;
}

/**
 * Parse the receiver's "FS ……" response into a per-proposal verdict, in order:
 *   '+'/'Y' accept · '-'/'N' reject (have it) · '=' defer/later. Anything else → reject.
 * A `!<offset>` resume answer is surfaced as a plain accept here; use `parseFSDetailed` for the offset.
 */
export function parseFS(line: string): ("accept" | "reject" | "defer")[] {
  return parseFSDetailed(line).map((v) => v.verdict);
}
