/**
 * session-script.ts — a pure, tick-driven scripted-session engine (Graphic Packet GPAUTO / `.gpa`).
 *
 * GPAUTO let an operator batch a `connect → waitfor → send → wait → disconnect` sequence against a BBS or
 * DX-cluster and capture the reply. We keep that as a **generic session-scripting mechanism**, not a
 * GP-specific feature: the engine drives an abstract `ScriptSession` (implemented by whatever surface owns
 * the AX.25 connection — the packet terminal, the node). The engine holds NO transport, NO tool knowledge;
 * a tool supplies the steps + renders progress. This is the docs/28 §5f invariant applied to automation:
 * the surface offers a `session.script` service, the tool decides what the script is.
 */

/** One scripted step. Kept tiny + serialisable so a tool (even a sandboxed one) can emit it. */
export type SessionStep =
  | { op: "connect"; call: string }
  | { op: "send"; text: string }
  | { op: "waitfor"; text: string; timeoutSec?: number }
  | { op: "wait"; sec: number }
  | { op: "disconnect" };

/** The abstract connection the engine drives — the surface (terminal/node) implements it over its session. */
export interface ScriptSession {
  connect(call: string): number;                 // open a channel, return its id
  send(id: number, text: string): void;          // send a line on the channel
  close(id: number): void;                        // close the channel
  channelState(id: number): string | undefined;   // "connected" | "disconnected" | …
  channelLines(id: number): string[];             // the channel's received (RX) lines, oldest→newest
}

export type ScriptStatus = "idle" | "running" | "done" | "error";
export interface ScriptState {
  status: ScriptStatus;
  step: number;          // 1-based index of the current/last step (0 while idle)
  total: number;
  captured: string[];    // RX lines gathered from the connected station
  note?: string;         // last human-readable note (waiting for…, timed out, …)
}

const DEFAULT_CONNECT_TIMEOUT = 30;
const DEFAULT_WAITFOR_TIMEOUT = 60;

/**
 * Parse a compact script: one step per line OR `;`-separated. First token = op.
 *   connect HB9W-8 | send sh/dx | waitfor Cluster [30] | wait 5 | disconnect
 * `#`/`REM`/`***` lines are comments (GPAUTO used `***REM`). Unknown lines are ignored.
 */
export function parseScript(text: string): SessionStep[] {
  const steps: SessionStep[] = [];
  for (const raw of String(text).split(/[\n;]/)) {
    const line = raw.trim().replace(/^\*\*\*/, "").trim();
    if (!line || line.startsWith("#") || /^rem\b/i.test(line)) continue;
    const sp = line.indexOf(" ");
    const op = (sp < 0 ? line : line.slice(0, sp)).toLowerCase();
    const rest = sp < 0 ? "" : line.slice(sp + 1).trim();
    if (op === "connect" && rest) steps.push({ op: "connect", call: rest.toUpperCase() });
    else if (op === "send") steps.push({ op: "send", text: rest });
    else if (op === "waitfor" && rest) {
      const m = rest.match(/^(.*?)(?:\s+(\d+))?$/);
      steps.push({ op: "waitfor", text: (m?.[1] ?? rest).trim(), timeoutSec: m?.[2] ? Number(m[2]) : undefined });
    } else if (op === "wait") steps.push({ op: "wait", sec: Math.max(0, Number(rest) || 0) });
    else if (op === "disconnect" || op === "bye") steps.push({ op: "disconnect" });
  }
  return steps;
}

/**
 * The engine. `tick(now)` is called on the surface's existing poll cadence (~1 Hz in the terminal); it
 * advances at most one waiting condition per tick and returns the current state when it changed (else null,
 * so the caller can cheaply skip re-emitting). `now` is injected (ms) — no Date.now() here (testable).
 */
export class ScriptRunner {
  private steps: SessionStep[] = [];
  private i = 0;
  private status: ScriptStatus = "idle";
  private chan: number | null = null;
  private note: string | undefined;
  private captured: string[] = [];
  private stepStart = 0;
  private consumed = 0;     // channelLines already folded into `captured`
  private lastEmit = "";

  constructor(private session: ScriptSession) {}

  /** Load + start a script (replaces any running one). */
  load(steps: SessionStep[], now: number): void {
    this.steps = steps.slice(0, 64);
    this.i = 0; this.chan = null; this.captured = []; this.consumed = 0; this.note = undefined;
    this.status = this.steps.length ? "running" : "idle";
    this.stepStart = now;
  }

  state(): ScriptState {
    return { status: this.status, step: Math.min(this.i + 1, this.steps.length), total: this.steps.length, captured: this.captured.slice(-40), note: this.note };
  }

  /** Fold any new RX lines from the active channel into `captured`; returns the newly-added lines. */
  private drain(): string[] {
    if (this.chan == null) return [];
    const all = this.session.channelLines(this.chan);
    const fresh = all.slice(this.consumed);
    this.consumed = all.length;
    if (fresh.length) { this.captured.push(...fresh); if (this.captured.length > 200) this.captured.splice(0, this.captured.length - 200); }
    return fresh;
  }

  private advance(now: number): void { this.i++; this.stepStart = now; if (this.i >= this.steps.length) { this.status = "done"; this.note = "complete"; } }
  private fail(msg: string): void { this.status = "error"; this.note = msg; }

  /** Advance the machine; returns the new state if it changed since the last tick, else null. */
  tick(now: number): ScriptState | null {
    if (this.status === "running") this.step(now);
    const sig = `${this.status}|${this.i}|${this.captured.length}|${this.note ?? ""}`;
    if (sig === this.lastEmit) return null;
    this.lastEmit = sig;
    return this.state();
  }

  private step(now: number): void {
    const s = this.steps[this.i]; if (!s) { this.status = "done"; return; }
    const elapsed = (now - this.stepStart) / 1000;
    switch (s.op) {
      case "connect": {
        if (this.chan == null) { this.chan = this.session.connect(s.call); this.consumed = 0; this.note = `connecting ${s.call}…`; return; }
        const st = this.session.channelState(this.chan);
        if (st === "connected") { this.note = `connected ${s.call}`; this.advance(now); }
        else if (st === "disconnected" && elapsed > 2) { this.fail(`connect to ${s.call} failed`); }
        else if (elapsed > DEFAULT_CONNECT_TIMEOUT) this.fail(`connect to ${s.call} timed out`);
        return;
      }
      case "send": {
        if (this.chan == null) { this.fail("send before connect"); return; }
        this.session.send(this.chan, s.text); this.note = `sent: ${s.text}`; this.advance(now); return;
      }
      case "waitfor": {
        const fresh = this.drain();
        this.note = `waiting for "${s.text}"`;
        if (fresh.some((l) => l.includes(s.text)) || this.captured.some((l) => l.includes(s.text))) { this.note = `matched "${s.text}"`; this.advance(now); }
        else if (elapsed > (s.timeoutSec ?? DEFAULT_WAITFOR_TIMEOUT)) { this.note = `timeout waiting for "${s.text}"`; this.advance(now); }
        return;
      }
      case "wait": { this.drain(); if (elapsed >= s.sec) this.advance(now); else this.note = `waiting ${Math.ceil(s.sec - elapsed)}s`; return; }
      case "disconnect": { if (this.chan != null) { this.drain(); this.session.close(this.chan); this.chan = null; } this.note = "disconnected"; this.advance(now); return; }
    }
  }
}
