// SPDX-License-Identifier: MIT
/**
 * rigctld.ts — a pure client for Hamlib's `rigctld` TCP text protocol. This is the
 * second CAT backend: where cat.ts (Backend A) drives a handful of rig families directly over Web Serial,
 * a **Hamlib `rigctld` companion** covers the 200+ rig long tail (iOS, non-Chromium, headless) with real
 * per-rig capability negotiation. We shell out to `rigctld` as a **separate process over TCP** and never
 * link Hamlib (it is (L)GPL) into our MIT `packages/*` — this file only speaks its wire protocol, so it
 * carries no Hamlib code and stays MIT-clean.
 *
 * Protocol (Hamlib "net rigctl"): one command per line; a lowercase letter GETs, uppercase SETs. A SET
 * replies `RPRT <code>` (0 = ok, negative = errno); a GET replies the value line(s) then implicitly ok,
 * or `RPRT <code>` on error. This module is PURE: it builds the command lines and parses the replies; the
 * companion owns the TCP socket. Frequencies are in Hz, matching cat.ts.
 */

/** Build a set-frequency line: `F <hz>`. Frequency is RX-side tuning (not H5-gated), same as cat.ts. */
export function rigctldSetFreq(hz: number): string {
  return `F ${Math.round(hz)}\n`;
}
/** Build a get-frequency line: `f` (reply is the Hz value). */
export function rigctldGetFreq(): string {
  return "f\n";
}
/** Build a set-mode line: `M <MODE> <passbandHz>`. Passband 0 = rig default. */
export function rigctldSetMode(mode: string, passbandHz = 0): string {
  return `M ${mode.toUpperCase()} ${Math.round(passbandHz)}\n`;
}
/** Build a get-mode line: `m` (reply is MODE then passband on the next line). */
export function rigctldGetMode(): string {
  return "m\n";
}
/** Build a set-PTT line: `T <0|1>`. Keying is H5-gated at the call site, never here. */
export function rigctldSetPtt(on: boolean): string {
  return `T ${on ? 1 : 0}\n`;
}
/** Build a get-PTT line: `t` (reply is 0/1). */
export function rigctldGetPtt(): string {
  return "t\n";
}
/** Ask the daemon to enumerate the connected rig's capabilities: `\dump_state`. */
export function rigctldDumpState(): string {
  return "\\dump_state\n";
}

export interface RprtResult {
  ok: boolean;
  code: number;
}

/** Parse a set-command reply (`RPRT <code>`). Missing/garbled → a non-ok result rather than a throw. */
export function parseRprt(reply: string): RprtResult {
  const m = /RPRT\s+(-?\d+)/.exec(reply);
  if (!m) return { ok: false, code: NaN };
  const code = Number(m[1]);
  return { ok: code === 0, code };
}

/**
 * Parse a get-frequency reply. rigctld returns the Hz value on its own line (or `RPRT -n` on error).
 * Returns the frequency in Hz, or null if the reply was an error / unparseable.
 */
export function parseFreqReply(reply: string): number | null {
  const line =
    reply
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? "";
  if (/^RPRT/.test(line)) return null;
  const hz = Number(line);
  return Number.isFinite(hz) && hz > 0 ? hz : null;
}

/** Parse a get-mode reply (`m`): the mode line then the passband line. */
export function parseModeReply(reply: string): { mode: string; passbandHz: number } | null {
  const lines = reply
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (!lines.length || /^RPRT/.test(lines[0]!)) return null;
  const mode = lines[0]!.toUpperCase();
  const passbandHz = lines.length > 1 ? Number(lines[1]) || 0 : 0;
  return { mode, passbandHz };
}

/**
 * A tiny client that maps our CAT operations onto rigctld lines over an injected async `send(line)` that
 * returns the daemon's reply. Pure of any socket: the companion supplies `send` (a TCP round-trip). This
 * mirrors cat.ts's Backend-A surface so callers can target either backend behind one API.
 */
export interface RigctldTransport {
  send(line: string): Promise<string>;
}

export class RigctldClient {
  constructor(private tx: RigctldTransport) {}
  async setFrequency(hz: number): Promise<RprtResult> {
    return parseRprt(await this.tx.send(rigctldSetFreq(hz)));
  }
  async getFrequency(): Promise<number | null> {
    return parseFreqReply(await this.tx.send(rigctldGetFreq()));
  }
  async setMode(mode: string, passbandHz = 0): Promise<RprtResult> {
    return parseRprt(await this.tx.send(rigctldSetMode(mode, passbandHz)));
  }
  async getMode(): Promise<{ mode: string; passbandHz: number } | null> {
    return parseModeReply(await this.tx.send(rigctldGetMode()));
  }
  /** PTT keying — the CALLER must H5-gate (verified callsign) before invoking this. */
  async setPtt(on: boolean): Promise<RprtResult> {
    return parseRprt(await this.tx.send(rigctldSetPtt(on)));
  }
  async getPtt(): Promise<boolean | null> {
    const v = (await this.tx.send(rigctldGetPtt())).trim().split(/\r?\n/)[0];
    return v === "1" ? true : v === "0" ? false : null;
  }
}
