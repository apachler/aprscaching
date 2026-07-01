/**
 * bbs.ts — the FBB/MBL-style connected-mode BBS command interpreter (docs/25 P2). This is the pure
 * "brain" a connected AX.25 session talks to: it takes one input line at a time and returns the lines
 * to send back (and whether to disconnect), operating on an injected MessageStore. No I/O, so it's
 * exhaustively unit-testable; the ingest wires it to incoming connects (validate-at-deploy), and the
 * web terminal can talk to it over a loopback. Command set mirrors F6FBB: L/LA/LB/LM/LL, R, S/SP/SB/
 * ST/SR, K, H, B, A, X (expert), I — with a subject+body collection prompt for sends.
 */
export type BbsType = "P" | "B" | "T";
export interface BbsMsgMeta { id: number; type: BbsType; from: string; to: string; subject: string | null; postedAt: number }
export interface BbsMsgFull extends BbsMsgMeta { body: string; replyTo?: number | null; readAt?: number | null }

export interface MessageStore {
  listNew(call: string): BbsMsgMeta[];        // unread personal to `call` + recent bulletins
  listAll(): BbsMsgMeta[];
  listBulletins(): BbsMsgMeta[];
  listMine(call: string): BbsMsgMeta[];
  read(id: number): BbsMsgFull | null;        // implementations may mark personal mail read
  post(m: { type: BbsType; from: string; to: string; subject: string | null; body: string; replyTo?: number | null }): number;
  kill(id: number, call: string): boolean;    // only the author/recipient may kill; returns success
}

interface Pending { type: BbsType; to: string; subject: string | null; replyTo: number | null; body: string[]; stage: "subject" | "body" }

const pad = (s: string, n: number) => (s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length));
const fmtRow = (m: BbsMsgMeta) => `${pad(String(m.id), 5)} ${m.type}  ${pad(m.to, 9)} ${pad(m.from, 9)} ${m.subject ?? ""}`.trimEnd();

const HELP = [
  "Commands:",
  "  L            list new        LA  list all      LB  bulletins",
  "  LM           list mine       LL n  last n",
  "  R n [n…]     read message(s)",
  "  S/SP call    send personal   SB cat  bulletin   ST call  traffic",
  "  SR [n]       reply to message n (or the last read)",
  "  K n          kill a message  A   abort a send",
  "  X            toggle expert   H/?  help          B   bye",
];

export class BbsSession {
  private pending: Pending | null = null;
  private lastRead = 0;
  private expert: boolean;
  readonly call: string;

  constructor(callsign: string, private store: MessageStore, private bbsCall = "BBS", opts: { expert?: boolean } = {}) {
    this.call = callsign.toUpperCase();
    this.expert = opts.expert ?? false;
  }

  /** The connect banner + first prompt. */
  greeting(): string[] {
    const n = this.store.listNew(this.call).length;
    return [
      `[APRScaching BBS ${this.bbsCall}]`,
      `Hello ${this.call} — ${n} new message${n === 1 ? "" : "s"}. Type H for help.`,
      this.prompt(),
    ];
  }

  private prompt(): string { return this.expert ? ">" : `${this.call} de ${this.bbsCall}>`; }
  private out(...lines: string[]): { lines: string[]; disconnect?: boolean } { return { lines: [...lines, this.prompt()] }; }

  /** Process one input line; returns the reply lines and an optional disconnect. */
  handle(input: string): { lines: string[]; disconnect?: boolean } {
    const line = input.replace(/\r?\n?$/, "");
    if (this.pending) return this.collect(line);

    const [wordRaw, ...rest] = line.trim().split(/\s+/);
    const word = (wordRaw ?? "").toUpperCase();
    const arg = rest.join(" ");
    if (!word) return { lines: [this.prompt()] };

    switch (word) {
      case "B": case "BYE": return { lines: [`73 de ${this.bbsCall}`], disconnect: true };
      case "H": case "?": return this.out(...HELP);
      case "X": this.expert = !this.expert; return this.out(`Expert mode ${this.expert ? "on" : "off"}.`);
      case "I": return this.out(`${this.bbsCall} — APRScaching connected-mode BBS. You are ${this.call}.`);
      case "L": return this.list(this.store.listNew(this.call), "New");
      case "LA": return this.list(this.store.listAll(), "All");
      case "LB": return this.list(this.store.listBulletins(), "Bulletins");
      case "LM": return this.list(this.store.listMine(this.call), "Mine");
      case "LL": return this.list(this.store.listAll().slice(0, Math.max(1, Number(arg) || 10)), `Last ${Number(arg) || 10}`);
      case "R": return this.read(rest);
      case "K": return this.kill(Number(arg));
      case "A": return this.out("No message in progress.");
      case "S": case "SP": return this.startSend("P", arg);
      case "SB": return this.startSend("B", arg);
      case "ST": return this.startSend("T", arg);
      case "SR": return this.startReply(Number(arg) || this.lastRead);
      default: return this.out(`Unknown command "${word}". Type H for help.`);
    }
  }

  // ---- listing / reading ----
  private list(msgs: BbsMsgMeta[], label: string): { lines: string[]; disconnect?: boolean } {
    if (msgs.length === 0) return this.out(`${label}: none.`);
    return this.out(`${label} (${msgs.length}):`, "   ID T  TO        FROM      SUBJECT", ...msgs.map(fmtRow));
  }
  private read(ids: string[]): { lines: string[]; disconnect?: boolean } {
    const nums = ids.map(Number).filter((n) => n > 0);
    if (nums.length === 0) return this.out("Usage: R <id> [id…]");
    const lines: string[] = [];
    for (const id of nums) {
      const m = this.store.read(id);
      if (!m) { lines.push(`Message ${id} not found.`); continue; }
      this.lastRead = id;
      lines.push(`Msg #${m.id}  ${m.type}  ${m.from} > ${m.to}  ${m.subject ?? "(no subject)"}`, ...m.body.split("\n"), "---");
    }
    return this.out(...lines);
  }
  private kill(id: number): { lines: string[]; disconnect?: boolean } {
    if (!id) return this.out("Usage: K <id>");
    return this.out(this.store.kill(id, this.call) ? `Message ${id} killed.` : `Can't kill ${id} (not found or not yours).`);
  }

  // ---- sending (subject then body collection) ----
  private startSend(type: BbsType, to: string): { lines: string[]; disconnect?: boolean } {
    if (!to) return this.out(`Usage: S${type === "B" ? "B <category>" : type === "T" ? "T <call>" : "P <call>"}`);
    this.pending = { type, to: to.toUpperCase(), subject: null, replyTo: null, body: [], stage: "subject" };
    return { lines: ["Subject:"] };
  }
  private startReply(id: number): { lines: string[]; disconnect?: boolean } {
    const m = id ? this.store.read(id) : null;
    if (!m) return this.out("Nothing to reply to — read a message first or pass an id (SR <id>).");
    const subject = m.subject && /^re:/i.test(m.subject) ? m.subject : `Re: ${m.subject ?? ""}`.trim();
    this.pending = { type: m.type === "P" ? "P" : m.type, to: m.from, subject, replyTo: m.id, body: [], stage: "body" };
    return { lines: [`Reply to ${m.from} — "${subject}". Enter message, end with /EX or a lone "." :`] };
  }
  private collect(line: string): { lines: string[]; disconnect?: boolean } {
    const p = this.pending!;
    if (p.stage === "subject") {
      p.subject = line.trim() || null; p.stage = "body";
      return { lines: ["Enter message, end with /EX or a lone \".\" :"] };
    }
    if (line.trim() === "/EX" || line.trim() === ".") {
      const id = this.store.post({ type: p.type, from: this.call, to: p.to, subject: p.subject, body: p.body.join("\n"), replyTo: p.replyTo });
      this.pending = null;
      return this.out(`Message ${id} stored (${p.type} to ${p.to}).`);
    }
    p.body.push(line);
    return { lines: [] }; // silent while collecting, like a real BBS
  }
}
