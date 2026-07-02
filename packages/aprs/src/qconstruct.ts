// SPDX-License-Identifier: MIT
/**
 * Classify APRS-IS entry from the q-construct in the path.
 *  RF-gated  (qAR/qAr/qAo/qAO) => "rf"      (heard on air, gated)
 *  injected  (qAC/qAX/qAU/...) => "aprs_is" (typed into a socket; spoofable)
 * The token AFTER the q-construct is the gating IGate's callsign.
 */
export type HeardVia = "rf" | "aprs_is";
const RF_Q = new Set(["qAR", "qAr", "qAo", "qAO"]);
const NET_Q = new Set(["qAC", "qAX", "qAU", "qAS", "qAI"]);

export function classifyQ(path: string[]): { heardVia: HeardVia; igateCall?: string } {
  for (let i = 0; i < path.length; i++) {
    const tok = path[i]!;
    if (RF_Q.has(tok)) return { heardVia: "rf", igateCall: path[i + 1] };
    if (NET_Q.has(tok)) return { heardVia: "aprs_is", igateCall: path[i + 1] };
  }
  return { heardVia: "aprs_is" };
}
