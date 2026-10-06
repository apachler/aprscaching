// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Which of this box's station calls the gateway knows as control-verified. A port that keys a transmitter
 * itself (the soundcard port) transmits only while every station call the box transmits under is verified,
 * the same rule the gateway applies to every transmission it queues. The answer comes from the gateway's
 * public `GET /verify/aprs/status?callsign=`, which reports the base call, so every SSID shares it.
 *
 * The box asks at start and again on a timer. A gateway that cannot be reached leaves the last answer in
 * place; until a first answer arrives, nothing counts as verified.
 */
import { gatewayFetch } from "./gatewayauth.js";

const base = (c: string) => (c.toUpperCase().split("-")[0] ?? "").trim();

export class CallVerifier {
  private verified = new Map<string, boolean>();

  constructor(private lookup: (call: string) => Promise<boolean>) {}

  /** Ask the gateway about each call's base call. A failed lookup keeps the previous answer. */
  async refresh(calls: readonly string[]): Promise<void> {
    for (const b of new Set(calls.map(base).filter(Boolean))) {
      try {
        this.verified.set(b, await this.lookup(b));
      } catch {
        /* unreachable gateway: keep what it said last */
      }
    }
  }

  /** The first call whose base call is not known as verified, or null when all are. */
  unverified(calls: readonly string[]): string | null {
    return calls.find((c) => this.verified.get(base(c)) !== true) ?? null;
  }
}

/** The lookup against a gateway at `gatewayBase` (the ingest URL without `/ingest`). */
export function gatewayVerifyLookup(gatewayBase: string, fetchFn: typeof gatewayFetch = gatewayFetch) {
  return async (call: string): Promise<boolean> => {
    const r = await fetchFn(`${gatewayBase}/verify/aprs/status?callsign=${encodeURIComponent(call)}`, {});
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return ((await r.json()) as { verified?: unknown }).verified === true;
  };
}

/**
 * The station calls a box transmits under, from its settings: every frame a soundcard port sends carries
 * one of them as its source or as the digipeater's own hop.
 */
export function stationCalls(env: Record<string, string | undefined>, portCall?: string): string[] {
  const keys = [
    "DIGI_CALL",
    "IGATE_CALL",
    "BOX_CALL",
    "NETROM_CALL",
    "BBS_NODE_CALL",
    "BBS_FORWARD_CALL",
    "FED_LINK_CALL",
  ] as const;
  const calls = [portCall, ...keys.map((k) => env[k])]
    .map((c) => c?.trim().toUpperCase())
    .filter((c): c is string => !!c);
  return [...new Set(calls)];
}
