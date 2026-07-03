// SPDX-License-Identifier: MIT
/**
 * thirdparty.ts — APRS-IS passcode + third-party (path-A) injection helpers. Pure; runs in
 * Worker/Node/browser. The passcode is NOT authorization (public hash) — see; it's here for
 * ops convenience + the direct-TX path. The third-party encapsulation is what a peer emits when gating
 * a *control-verified* user's traffic into APRS-IS under the user's own call.
 */

/** The public APRS-IS passcode for a callsign (base call only; SSID-independent). NOT authorization. */
export function aprsPasscode(call: string): number {
  const c = call
    .toUpperCase()
    .replace(/-.*/, "")
    .replace(/[^A-Z0-9]/g, "");
  let hash = 0x73e2;
  for (let i = 0; i < c.length; i += 2) {
    hash ^= c.charCodeAt(i) << 8;
    if (i + 1 < c.length) hash ^= c.charCodeAt(i + 1);
  }
  return hash & 0x7fff;
}

/**
 * Build the third-party encapsulated line a peer injects into APRS-IS on behalf of a user:
 *   `GATECALL>APRS,TCPIP*:}USERCALL>DST,TCPIP*:<info>`
 * The `}` marks third-party traffic; the inner source is the USER's call (gated by the peer's login).
 * `info` is the raw APRS info field (position/message/status) — build it with encodeAprs* helpers.
 * Caller MUST have control-verified `userCall` first — this function does not (and cannot) verify.
 */
export function thirdPartyEncap(opts: { gateCall: string; userCall: string; info: string; dst?: string }): string {
  const gate = opts.gateCall.toUpperCase();
  const user = opts.userCall.toUpperCase();
  const dst = (opts.dst || "APZACG").toUpperCase();
  return `${gate}>APRS,TCPIP*:}${user}>${dst},TCPIP*:${opts.info}`;
}
