// SPDX-License-Identifier: MIT
/**
 * sessions.ts — what a surface with connected sessions (the packet terminal; any surface that opens AX.25 or
 * NET/ROM sessions) owes the tools. The surface reports its sessions; this raises `on_connect` and `on_disconnect`
 * through the ToolHost, hands each tool a reply on sessions another station opened, and runs the commands tools
 * opened to connected stations (`remote: true`) when such a station types the word.
 *
 * Tools answer only on incoming sessions. On a session this station opened (to a BBS, a node, a cluster) the
 * operator does the talking, and the far end's lines are its prompts and output, not commands for the tools; a tool
 * answering them would type into someone else's BBS. One side of every link is outgoing, which also keeps two
 * stations' tools from answering each other in a loop.
 *
 * Every line leaves through the surface's own `send`, after its own transmit gate (`txBlocked`): a control-verified
 * callsign and this tab's transmit consent. A remote command's output is held to the reply limits: REPLY_MAX lines of
 * REPLY_TEXT_MAX characters, sent within REPLY_TTL_MS. The surface's own commands win: a word it answers itself
 * (`ownsWord`) never reaches a tool. Pure: no DOM, no timers.
 */
import { REPLY_MAX, REPLY_TTL_MS, replyLine, type SessionDirection, type SessionInfo, type ToolHost } from "./host.js";
import type { Surface } from "./surfaces.js";

/** One session as the surface sees it now. `open` is true while the link is up. */
export interface SurfaceSession {
  channel: number;
  peerCall: string;
  myCall: string;
  direction: SessionDirection;
  open: boolean;
}

/** What a remote command answered: the tool that ran it and its output lines. */
export interface RemoteAnswer {
  tool: string;
  lines: string[];
}

export interface SessionEventsOpts {
  host: Pick<ToolHost, "dispatchSession">;
  surface: Surface;
  /** Send one line on a session for a tool, through the surface's own path. */
  send(channel: number, text: string, tool: string): void;
  /** Why the surface may not transmit now, or null when it may. Read before every line. */
  txBlocked(): string | null;
  /** Run a command a running tool opened to connected stations; null when none answers the word. */
  runRemote(word: string, args: string, surface: Surface): Promise<RemoteAnswer | null> | RemoteAnswer | null;
  /** True for a word the surface answers itself: its own commands win over a tool's. */
  ownsWord?(word: string): boolean;
  /** A note for the operator (a refused reply, a dropped command). */
  log?(msg: string): void;
  now?: () => number;
}

/** A remote command: a word of letters, digits and dashes, then its arguments. A leading slash is not one. */
// One separator character, and the rest taken as it is: no two parts can trade characters, so matching stays linear.
const COMMAND_RE = /^([A-Za-z][A-Za-z0-9-]{0,31})(?:\s([\s\S]*))?$/;
/** The most remote commands that wait on one session, the running one included. */
export const REMOTE_QUEUE_MAX = 4;

export class SessionEvents {
  private open = new Map<number, SessionInfo>();
  private queues = new Map<number, { tail: Promise<void>; waiting: number }>(); // remote commands, per session

  constructor(private o: SessionEventsOpts) {}

  private now(): number {
    return (this.o.now ?? Date.now)();
  }

  /** Report the surface's sessions: a session newly up raises `on_connect`, one gone or down `on_disconnect`. */
  sync(sessions: readonly SurfaceSession[]): void {
    const up = new Set<number>();
    for (const s of sessions) {
      if (!s.open) continue;
      up.add(s.channel);
      if (this.open.has(s.channel)) continue;
      const info: SessionInfo = {
        surface: this.o.surface,
        channel: s.channel,
        peerCall: s.peerCall,
        myCall: s.myCall,
        direction: s.direction,
      };
      this.open.set(s.channel, info);
      this.o.host.dispatchSession("on_connect", info, info.direction === "incoming" ? this.sender(info) : undefined);
    }
    for (const [channel, info] of [...this.open]) if (!up.has(channel)) this.end(channel, info);
  }

  /** Every session ended (the surface closed its link). */
  closeAll(): void {
    for (const [channel, info] of [...this.open]) this.end(channel, info);
  }

  private end(channel: number, info: SessionInfo): void {
    this.open.delete(channel);
    this.queues.delete(channel);
    this.o.host.dispatchSession("on_disconnect", info);
  }

  /** A line for a tool on one session, through the surface's gate; null once sent, else why not. */
  private sendOn(info: SessionInfo, text: string, tool: string): string | null {
    if (this.open.get(info.channel) !== info) return "the session has closed";
    const why = this.o.txBlocked();
    if (why) return why;
    this.o.send(info.channel, text, tool);
    return null;
  }
  private sender(info: SessionInfo) {
    return (text: string, tool: string) => this.sendOn(info, text, tool);
  }

  /**
   * A line the remote station sent. On an incoming session, a line that starts with a word a tool opened to
   * connected stations runs that command and sends its output back on the session. Commands run one after another,
   * in the order they arrived; at most REMOTE_QUEUE_MAX wait on a session, and a line beyond them is not run.
   */
  line(channel: number, text: string): void {
    const info = this.open.get(channel);
    if (!info || info.direction !== "incoming") return;
    const m = COMMAND_RE.exec(text.trim().slice(0, 256));
    if (!m) return;
    const word = m[1]!.toLowerCase();
    if (this.o.ownsWord?.(word)) return;
    const q = this.queues.get(channel) ?? { tail: Promise.resolve(), waiting: 0 };
    if (q.waiting >= REMOTE_QUEUE_MAX) {
      this.o.log?.(`${info.peerCall}: "${word}" not run, ${REMOTE_QUEUE_MAX} commands are still waiting`);
      return;
    }
    q.waiting++;
    q.tail = q.tail.then(() => this.runOne(info, word, (m[2] ?? "").trim())).finally(() => q.waiting--);
    this.queues.set(channel, q);
  }

  /** Run one remote command and send its output, unless the session closed meanwhile. */
  private async runOne(info: SessionInfo, word: string, args: string): Promise<void> {
    if (this.open.get(info.channel) !== info) return;
    const until = this.now() + REPLY_TTL_MS;
    let out: RemoteAnswer | null;
    try {
      out = await this.o.runRemote(word, args, this.o.surface);
    } catch (e) {
      this.o.log?.(`"${word}" failed: ${(e as Error).message}`);
      return;
    }
    if (!out || this.open.get(info.channel) !== info) return;
    if (this.now() > until) return this.o.log?.(`${out.tool}: "${word}" answered too late`);
    for (const l of out.lines.slice(0, REPLY_MAX)) {
      const line = replyLine(l);
      if (!line.trim()) continue;
      const why = this.sendOn(info, line, out.tool);
      if (why) return this.o.log?.(`${out.tool}: "${word}" not answered: ${why}`);
    }
  }
}
