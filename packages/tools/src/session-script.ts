// SPDX-License-Identifier: MIT
/**
 * session-script.ts — a pure, tick-driven scripted-session engine (Graphic Packet GPAUTO / `.gpa`).
 *
 * GPAUTO let an operator batch a `connect → waitfor → send → wait → disconnect` sequence against a BBS or
 * DX-cluster and capture the reply. We keep that as a **generic session-scripting mechanism**, not a
 * GP-specific feature: the engine drives an abstract `ScriptSession` (implemented by whatever surface owns
 * the AX.25 connection — the packet terminal, the node). The engine holds NO transport, NO tool knowledge;
 * a tool supplies the steps + renders progress. This is the §5f invariant applied to automation:
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
  connect(call: string): number; // open a channel, return its id
  send(id: number, text: string): void; // send a line on the channel
  close(id: number): void; // close the channel
  channelState(id: number): string | undefined; // "connected" | "disconnected" | …
  channelLines(id: number): string[]; // the channel's received (RX) lines, oldest→newest
}

export type ScriptStatus = "idle" | "running" | "done" | "error";
export interface ScriptState {
  status: ScriptStatus;
  step: number; // 1-based index of the current/last step (0 while idle)
  total: number;
  captured: string[]; // RX lines gathered from the connected station
  note?: string; // last human-readable note (waiting for…, timed out, …)
}

const DEFAULT_CONNECT_TIMEOUT = 30;
const DEFAULT_WAITFOR_TIMEOUT = 60;

/**
 * Split `waitfor <text> [<seconds>]`: a trailing whitespace-separated digit run is the timeout. Walked
 * back from the end so a long whitespace run inside the text stays linear.
 */
function splitTimeout(rest: string): { text: string; timeoutSec?: number } {
  let i = rest.length;
  while (i > 0 && /\d/.test(rest[i - 1]!)) i--;
  const digitsStart = i;
  while (i > 0 && /\s/.test(rest[i - 1]!)) i--;
  const hasTimeout = digitsStart < rest.length && i < digitsStart;
  const text = hasTimeout ? rest.slice(0, i) : rest;
  // The pattern text is a single line; one that spans lines carries no timeout.
  if (/[\n\r\u2028\u2029]/.test(text)) return { text: rest.trim() };
  return { text: text.trim(), timeoutSec: hasTimeout ? Number(rest.slice(digitsStart)) : undefined };
}

/**
 * Parse a compact script: one step per line OR `;`-separated. First token = op.
 *   connect HB9W-8 | send sh/dx | waitfor Cluster [30] | wait 5 | disconnect
 * `#`/`REM`/`***` lines are comments (GPAUTO used `***REM`). Unknown lines are ignored.
 */
export function parseScript(text: string): SessionStep[] {
  const steps: SessionStep[] = [];
  for (const raw of String(text).split(/[\n;]/)) {
    const line = raw
      .trim()
      .replace(/^\*\*\*/, "")
      .trim();
    if (!line || line.startsWith("#") || /^rem\b/i.test(line)) continue;
    const sp = line.indexOf(" ");
    const op = (sp < 0 ? line : line.slice(0, sp)).toLowerCase();
    const rest = sp < 0 ? "" : line.slice(sp + 1).trim();
    if (op === "connect" && rest) steps.push({ op: "connect", call: rest.toUpperCase() });
    else if (op === "send") steps.push({ op: "send", text: rest });
    else if (op === "waitfor" && rest) {
      const { text, timeoutSec } = splitTimeout(rest);
      steps.push({ op: "waitfor", text, timeoutSec });
    } else if (op === "wait") steps.push({ op: "wait", sec: Math.max(0, Number(rest) || 0) });
    else if (op === "disconnect" || op === "bye") steps.push({ op: "disconnect" });
  }
  return steps;
}

/** The most steps one script holds, and the bounds of each step a tool hands the `session.script` service. */
export const SCRIPT_MAX_STEPS = 20;
const SCRIPT_TEXT_MAX = 256;
const SCRIPT_MATCH_MAX = 80;
const SCRIPT_SECONDS_MAX = 600;
const SCRIPT_CALL = /^[A-Z0-9]{1,6}(-([0-9]|1[0-5]))?$/;

/**
 * Check the steps a tool hands the `session.script` service: an array of at most SCRIPT_MAX_STEPS known steps,
 * starting with a `connect` to a callsign, each line one line long and within its bounds. The checked steps, or
 * why they are refused.
 */
export function validateSteps(input: unknown): SessionStep[] | string {
  if (!Array.isArray(input) || input.length === 0) return "a script is a list of steps";
  if (input.length > SCRIPT_MAX_STEPS) return `a script holds at most ${SCRIPT_MAX_STEPS} steps`;
  const line = (x: unknown, max: number) =>
    typeof x === "string" && x.length <= max && !/[\r\n\0]/.test(x) ? x : null;
  const out: SessionStep[] = [];
  for (const [i, raw] of input.entries()) {
    const s = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
    const bad = `step ${i + 1} is not a valid ${typeof s.op === "string" ? s.op.slice(0, 20) : "step"}`;
    switch (s.op) {
      case "connect": {
        const call = typeof s.call === "string" ? s.call.toUpperCase() : "";
        if (!SCRIPT_CALL.test(call)) return bad;
        out.push({ op: "connect", call });
        break;
      }
      case "send": {
        const text = line(s.text, SCRIPT_TEXT_MAX);
        if (text === null) return bad;
        out.push({ op: "send", text });
        break;
      }
      case "waitfor": {
        const text = line(s.text, SCRIPT_MATCH_MAX);
        const t = s.timeoutSec;
        if (!text || (t !== undefined && !(typeof t === "number" && t >= 1 && t <= SCRIPT_SECONDS_MAX))) return bad;
        out.push({ op: "waitfor", text, ...(t !== undefined ? { timeoutSec: t } : {}) });
        break;
      }
      case "wait": {
        const sec = s.sec;
        if (!(typeof sec === "number" && sec >= 0 && sec <= SCRIPT_SECONDS_MAX)) return bad;
        out.push({ op: "wait", sec });
        break;
      }
      case "disconnect":
        out.push({ op: "disconnect" });
        break;
      default:
        return bad;
    }
  }
  if (out[0]!.op !== "connect") return "a script starts with a connect";
  return out;
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
  private consumed = 0; // channelLines already folded into `captured`
  private lastEmit = "";

  constructor(private session: ScriptSession) {}

  /** Load + start a script. It replaces any running one, whose open channel is closed first. */
  load(steps: SessionStep[], now: number): void {
    if (this.chan != null) this.session.close(this.chan);
    this.steps = steps.slice(0, 64);
    this.i = 0;
    this.chan = null;
    this.captured = [];
    this.consumed = 0;
    this.note = undefined;
    this.status = this.steps.length ? "running" : "idle";
    this.stepStart = now;
  }

  /** A script is running. */
  busy(): boolean {
    return this.status === "running";
  }

  state(): ScriptState {
    return {
      status: this.status,
      step: Math.min(this.i + 1, this.steps.length),
      total: this.steps.length,
      captured: this.captured.slice(-40),
      note: this.note,
    };
  }

  /** Fold any new RX lines from the active channel into `captured`; returns the newly-added lines. */
  private drain(): string[] {
    if (this.chan == null) return [];
    const all = this.session.channelLines(this.chan);
    const fresh = all.slice(this.consumed);
    this.consumed = all.length;
    if (fresh.length) {
      this.captured.push(...fresh);
      if (this.captured.length > 200) this.captured.splice(0, this.captured.length - 200);
    }
    return fresh;
  }

  private advance(now: number): void {
    this.i++;
    this.stepStart = now;
    if (this.i >= this.steps.length) {
      this.status = "done";
      this.note = "complete";
    }
  }
  private fail(msg: string): void {
    this.status = "error";
    this.note = msg;
  }

  /** Advance the machine; returns the new state if it changed since the last tick, else null. */
  tick(now: number): ScriptState | null {
    if (this.status === "running") this.step(now);
    const sig = `${this.status}|${this.i}|${this.captured.length}|${this.note ?? ""}`;
    if (sig === this.lastEmit) return null;
    this.lastEmit = sig;
    return this.state();
  }

  private step(now: number): void {
    const s = this.steps[this.i];
    if (!s) {
      this.status = "done";
      return;
    }
    const elapsed = (now - this.stepStart) / 1000;
    switch (s.op) {
      case "connect": {
        if (this.chan == null) {
          this.chan = this.session.connect(s.call);
          this.consumed = 0;
          this.note = `connecting ${s.call}…`;
          return;
        }
        const st = this.session.channelState(this.chan);
        if (st === "connected") {
          this.note = `connected ${s.call}`;
          this.advance(now);
        } else if (st === "disconnected" && elapsed > 2) {
          this.fail(`connect to ${s.call} failed`);
        } else if (elapsed > DEFAULT_CONNECT_TIMEOUT) this.fail(`connect to ${s.call} timed out`);
        return;
      }
      case "send": {
        if (this.chan == null) {
          this.fail("send before connect");
          return;
        }
        this.session.send(this.chan, s.text);
        this.note = `sent: ${s.text}`;
        this.advance(now);
        return;
      }
      case "waitfor": {
        const fresh = this.drain();
        this.note = `waiting for "${s.text}"`;
        if (fresh.some((l) => l.includes(s.text)) || this.captured.some((l) => l.includes(s.text))) {
          this.note = `matched "${s.text}"`;
          this.advance(now);
        } else if (elapsed > (s.timeoutSec ?? DEFAULT_WAITFOR_TIMEOUT)) {
          this.note = `timeout waiting for "${s.text}"`;
          this.advance(now);
        }
        return;
      }
      case "wait": {
        this.drain();
        if (elapsed >= s.sec) this.advance(now);
        else this.note = `waiting ${Math.ceil(s.sec - elapsed)}s`;
        return;
      }
      case "disconnect": {
        if (this.chan != null) {
          this.drain();
          this.session.close(this.chan);
          this.chan = null;
        }
        this.note = "disconnected";
        this.advance(now);
        return;
      }
    }
  }
}
