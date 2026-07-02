// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * provenance.ts — derive a packet's {@link Provenance} from how it reached us (docs/design/22).
 *
 * This is the single place that decides `firstPartyAttested`. The verification engine consumes only
 * that boolean (never the transport), so the transport-vs-trust rule lives here and cannot leak into
 * trust branching: "transport convenience is not trust uplift."
 *
 * Attestation today:
 *   - A position heard on RF (`heard_via = 'rf'`) with an RF-originated q-construct (qAR/qAO) and an
 *     independent gating IGate is treated as first-party attested. In the single-instance launch the
 *     gating IGate IS, operationally, the receiving site feeding this instance.
 *   - If the operator pins an explicit allowlist (`FIRST_PARTY_SITES`), attestation narrows to gates
 *     on that list — the honest posture for the deferred owned-RF / HAMNET track.
 *   - Everything else (bare APRS-IS injection qAC/qAX, app geo, any tunnelled transport) → not
 *     attested → cannot reach Tier A.
 */
import type { Transport, Provenance } from "@aprsweb/shared";

export interface RawProvenance {
  heard_via: "rf" | "aprs_is" | "app" | string;
  igate_call?: string | null;
  path?: string | null;            // stored APRS path incl. the q-construct
  ts?: number;
}

/** RF-originated q-constructs: the IGate is asserting it heard this frame on-air. */
const RF_QCONSTRUCT = /^q(AR|AO)$/;

/** Pull the qXX token out of a stored comma path (e.g. "WIDE1-1,qAR,OE8XXX"). */
export function qConstructOf(path?: string | null): string | undefined {
  for (const t of (path ?? "").split(",")) { const s = t.trim(); if (/^q[A-Z]{2}$/.test(s)) return s; }
  return undefined;
}

/** Parse a comma/space list of attested site callsigns (uppercased); empty ⇒ no explicit allowlist. */
export function parseAttestedSites(raw?: string | null): Set<string> {
  return new Set((raw ?? "").split(/[,\s]+/).map((s) => s.trim().toUpperCase()).filter(Boolean));
}

/** Map how a stored position reached us onto the reserved transport enum. */
function transportOf(p: RawProvenance): Transport {
  if (p.heard_via === "app") return "app";
  // RF and IS positions both arrive over the APRS-IS firehose today; the reserved transports
  // (axudp/axip/hamnet-kiss/first-party-rf) are set by their own listeners when those land.
  return "aprs-is";
}

/**
 * Derive provenance for a stored position. `attestedSites` (operator allowlist) narrows attestation
 * when non-empty; when empty we fall back to the qAR-RF + independent-IGate single-instance rule.
 */
export function provenanceOf(p: RawProvenance, attestedSites?: Set<string>): Provenance {
  const qConstruct = qConstructOf(p.path);
  const igate = (p.igate_call ?? "").toUpperCase();
  const rfOriginated = p.heard_via === "rf" && (!qConstruct || RF_QCONSTRUCT.test(qConstruct));
  const siteOk = attestedSites && attestedSites.size > 0 ? attestedSites.has(igate) : !!igate;
  const firstPartyAttested = rfOriginated && siteOk;
  return {
    transport: transportOf(p),
    ...(qConstruct ? { qConstruct } : {}),
    firstPartyAttested,
    ...(igate ? { siteId: igate } : {}),
    ...(p.ts != null ? { heardAt: p.ts } : {}),
  };
}
