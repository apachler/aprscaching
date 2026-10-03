// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The callsigns this box uses, checked against what the gateway names: its service call and its attested
 * receiving sites (`FIRST_PARTY_SITES`). Both sides hold a copy of a call that must agree, and a mismatch
 * fails silently on air, so the box says so in its log.
 */
import { parseMeshcomNodes } from "./meshcom.js";

type Env = Record<string, string | undefined>;
const up = (c: string | undefined) => c?.trim().toUpperCase() || undefined;

/** Every call a station of this box transmits or is heard under, with the setting that names it. */
export function stationCalls(env: Env): { key: string; call: string }[] {
  const keys = [
    "BOX_CALL",
    "IGATE_CALL",
    "DIGI_CALL",
    "RF_SITE_CALL",
    "APRSIS_CALLSIGN",
    "NETROM_CALL",
    "BBS_NODE_CALL",
    "BBS_FORWARD_CALL",
    "HOSTMODE_MYCALL",
    "MESHCOM_TX_CALL",
  ];
  const out = keys.flatMap((key) => (up(env[key]) ? [{ key, call: up(env[key])! }] : []));
  for (const n of parseMeshcomNodes(env.MESHCOM_NODE ?? ""))
    if (n.call) out.push({ key: "MESHCOM_NODE", call: n.call });
  return out;
}

/**
 * What the box should warn about, given the gateway's service call and attested sites (`sites` absent when
 * the gateway does not name them): a station of this box on the service call, whose commands the gateway
 * ignores as its own and whose MeshCom node takes players' messages as its own; and a receiving site of this
 * box the gateway does not attest, whose direct hearings never reach Tier A.
 */
export function callWarnings(env: Env, serviceCall: string, sites?: string[]): string[] {
  const out: string[] = [];
  const service = serviceCall.toUpperCase();
  for (const s of stationCalls(env))
    if (s.call === service)
      out.push(`${s.key} ${s.call} is the gateway's service call; give that station another SSID`);
  if (sites) {
    const attested = new Set(sites.map((c) => c.toUpperCase()));
    const own: { key: string; call: string }[] = [];
    // only a site named for attestation: an IGate's call alone may be a TNC someone else operates
    const site = up(env.RF_SITE_CALL);
    if (site && (env.KISS_TNC_HOST || env.AGWPE_HOST || env.HOSTMODE_HOST))
      own.push({ key: "RF_SITE_CALL", call: site });
    for (const n of parseMeshcomNodes(env.MESHCOM_NODE ?? ""))
      if (n.call) own.push({ key: "MESHCOM_NODE", call: n.call });
    for (const o of own)
      if (!attested.has(o.call))
        out.push(
          `${o.key} ${o.call} is not in the gateway's FIRST_PARTY_SITES: what it hears directly never reaches Tier A`,
        );
  }
  return out;
}
