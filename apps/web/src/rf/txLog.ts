// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * txLog.ts — the words for what this browser transmitted: a short summary of each outgoing frame for the
 * Recent transmissions list, and the throttle that keeps the screen-reader announcement of a transmission to one
 * every few seconds. Pure, so the radio store and its tests share it.
 */
import { addrStr, type Ax25Frame } from "@aprscaching/ax25";

/** The part of the app a transmission came from, as the Recent transmissions list names it. */
export type TxFeature = "Messages" | "Terminal" | "My radio" | `Tool ${string}`;

/** One outgoing frame, kept in this tab's memory only: never sent to the gateway, never stored. */
export interface TxEntry {
  id: number;
  /** Milliseconds since the epoch. */
  at: number;
  src: string;
  dst: string;
  path: string[];
  /** Who the frame is for: an APRS message's addressee, otherwise the destination. */
  to: string;
  summary: string;
  feature: TxFeature;
}

const SUMMARY_MAX = 60;
const clip = (s: string) => {
  const t = s.replace(/[\r\n]+/g, " ").trim();
  return t.length > SUMMARY_MAX ? `${t.slice(0, SUMMARY_MAX - 1)}…` : t;
};

/** The addressee of an APRS message payload (`:ADDRESSEE:text`), or null for any other payload. */
function messageTo(payload: string): string | null {
  return payload[0] === ":" && payload[10] === ":" ? payload.slice(1, 10).trim() : null;
}

/** A short decoded summary of an APRS payload: a message, an acknowledgement, a position, a status, … */
export function aprsSummary(payload: string): string {
  const to = messageTo(payload);
  if (to != null) {
    const text = payload.slice(11);
    const reply = /^(ack|rej)([A-Za-z0-9]{1,5})/.exec(text);
    if (reply) return `${reply[1] === "ack" ? "acknowledgement" : "reject"} ${reply[2]} to ${to}`;
    return clip(`message to ${to}: ${text.replace(/\{[A-Za-z0-9}]{1,6}$/, "")}`);
  }
  const c = payload[0] ?? "";
  if ("!=/@".includes(c) && c) return "position";
  if (c === "`" || c === "'") return "position (Mic-E)";
  if (c === ">") return clip(`status: ${payload.slice(1)}`);
  if (c === ";") return clip(`object ${payload.slice(1, 10).trim()}`);
  if (c === ")") return clip(`item ${payload.slice(1).split(/[!_]/)[0] ?? ""}`);
  if (c === "_") return "weather";
  if (payload.startsWith("T#")) return "telemetry";
  return clip(payload) || "empty frame";
}

const CONNECTED: Partial<Record<Ax25Frame["type"], string>> = {
  SABM: "connect request",
  SABME: "connect request",
  DISC: "disconnect",
  UA: "accept",
  DM: "refuse",
  FRMR: "frame reject",
  RR: "acknowledge",
  RNR: "busy",
  REJ: "resend request",
  SREJ: "resend request",
};

/** A short summary of a connected-mode (or UI) AX.25 frame the packet terminal sends. */
export function ax25Summary(f: Ax25Frame): string {
  const text = f.info ? new TextDecoder().decode(f.info) : "";
  if (f.type === "UI") return aprsSummary(text);
  if (f.type === "I") return clip(`text: ${text}`) || "text";
  return CONNECTED[f.type] ?? f.type;
}

/** An outgoing frame described for the Recent transmissions list, without its id and time. */
export type TxNote = Omit<TxEntry, "id" | "at">;

/** A frame the packet terminal sends, described for the Recent transmissions list; a tool's line names the tool. */
export function terminalTxNote(f: Ax25Frame, feature: TxFeature = "Terminal"): TxNote {
  const dst = addrStr(f.dst);
  return {
    src: addrStr(f.src),
    dst,
    path: (f.digis ?? []).map(addrStr),
    to: dst,
    summary: ax25Summary(f),
    feature,
  };
}

/** An APRS frame sent over the browser radio link, described for the Recent transmissions list. */
export function aprsTxNote(
  frame: { src: string; dst: string; path?: string[]; payload: string },
  feature: TxFeature,
): TxNote {
  return {
    src: frame.src,
    dst: frame.dst,
    path: frame.path ?? [],
    to: messageTo(frame.payload) ?? frame.dst,
    summary: aprsSummary(frame.payload),
    feature,
  };
}

/** The shortest gap between two screen-reader announcements of a transmission. */
export const ANNOUNCE_GAP_MS = 5000;

/**
 * Announce transmissions politely: at most one "Transmitted to …" every few seconds, however many frames go out.
 * A frame inside the gap is announced once the gap ends, naming the latest destination, so the last word is
 * always about the last frame.
 */
export class TxAnnouncer {
  private last = Number.NEGATIVE_INFINITY;
  private pending: string | null = null;
  private timer: unknown = null;

  constructor(
    private say: (text: string) => void,
    private clock: {
      now(): number;
      setTimer(fn: () => void, ms: number): unknown;
      clearTimer(t: unknown): void;
    } = {
      now: () => Date.now(),
      setTimer: (fn, ms) => setTimeout(fn, ms),
      clearTimer: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
    },
    private gapMs = ANNOUNCE_GAP_MS,
  ) {}

  note(to: string): void {
    this.pending = to;
    const wait = this.last + this.gapMs - this.clock.now();
    if (wait <= 0) this.fire();
    else if (this.timer == null)
      this.timer = this.clock.setTimer(() => {
        this.timer = null;
        this.fire();
      }, wait);
  }

  stop(): void {
    if (this.timer != null) this.clock.clearTimer(this.timer);
    this.timer = null;
    this.pending = null;
  }

  private fire(): void {
    if (this.pending == null) return;
    this.say(`Transmitted to ${this.pending}`);
    this.pending = null;
    this.last = this.clock.now();
  }
}
