// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * provenance.ts — derive a packet's {@link Provenance} from how it reached us.
 *
 * This is the single place that decides `firstPartyAttested`. The verification engine consumes only
 * that boolean (never the transport), so the transport-vs-trust rule lives here and cannot leak into
 * trust branching: "transport convenience is not trust uplift."
 *
 * Attestation is default-deny, and it follows the path a frame took to reach the gateway:
 *   - Only a frame the attested site's own receiver heard, delivered by that site's own ingest, is first-party
 *     attested: a local TNC (KISS, AGWPE, WA8DED host mode → `tnc`) or a MeshCom node (`meshcom`) on the
 *     operator's ingest box, whose writes need INGEST_SECRET (a signed batch records `browser-rf`, whatever
 *     port it names). The ingest stamps a direct hearing with the site call as `igate_call`, the frame is
 *     `heard_via = 'rf'`, and that site must be on the operator allowlist (`FIRST_PARTY_SITES`, or a station the sysop trusts in Instance admin; attestedsites.ts). An on-air frame carries no q-construct of
 *     its own; one that does must name an RF gate (qAR/qAO).
 *   - An APRS-IS line is never attested, whatever it says: APRS-IS passcodes are public, so anyone can
 *     inject `…,qAR,<attested site>`. A standalone IGate visible only on APRS-IS therefore counts for nothing here — it must run the ingest box for its
 *     hearings to reach Tier A.
 *   - With no allowlist set, nothing is first-party attested — Tier A stays closed until the operator
 *     names their own sites.
 *   - A browser-bridge batch (`browser-rf`) is never attested. It is signed by the sender's own device key
 *     and may carry only the signer's own frames, stored without a receiving site: it proves who sent the
 *     batch, not that an independent site heard it.
 *   - An internet tunnel (AXUDP, AXIP) or a licence-free carrier (Meshtastic) is never attested, whatever
 *     its `heard_via` and site claim — no receiver the operator runs heard it on amateur RF.
 */
import { Transport as TransportEnum, type Transport, type Provenance } from "@aprscaching/shared";

export interface RawProvenance {
  // The `& {}` keeps the known-value suggestions without the union collapsing to bare `string`.
  heard_via: "rf" | "aprs_is" | "app" | (string & {});
  igate_call?: string | null;
  path?: string | null; // stored APRS path incl. the q-construct
  ts?: number;
  transport?: string | null; // how the position reached the gateway (positions.transport)
}

/** RF-originated q-constructs: the IGate is asserting it heard this frame on-air. */
const RF_QCONSTRUCT = /^q(AR|AO)$/;

/** Pull the qXX token out of a stored comma path (e.g. "WIDE1-1,qAR,OE8XXX"). */
export function qConstructOf(path?: string | null): string | undefined {
  for (const t of (path ?? "").split(",")) {
    const s = t.trim();
    if (/^q[A-Z]{2}$/.test(s)) return s;
  }
  return undefined;
}

/** Parse a comma/space list of attested site callsigns (uppercased); empty ⇒ no explicit allowlist. */
export function parseAttestedSites(raw?: string | null): Set<string> {
  return new Set(
    (raw ?? "")
      .split(/[,\s]+/)
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean),
  );
}

/**
 * First-party on-air transports: the operator's own ingest box heard the frame on its own receiver. The
 * only transports that can carry attestation.
 */
const ON_AIR: ReadonlySet<Transport> = new Set<Transport>(["tnc", "meshcom"]);

/** Transports that never carry first-party RF evidence: internet tunnels and licence-free carriers. */
const NEVER_ATTESTED: ReadonlySet<Transport> = new Set<Transport>(["axudp", "axip", "meshtastic"]);

/** Ingest port → transport. One table for every port a driver emits; any other port records `unknown`. */
const PORT_TRANSPORT: Readonly<Record<string, Transport>> = {
  "aprs-is": "aprs-is",
  "kiss-tnc": "tnc",
  agwpe: "tnc",
  hostmode: "tnc",
  "webserial-kiss": "browser-rf",
  "browser-rf": "browser-rf",
  axudp: "axudp",
  axip: "axip",
  meshcom: "meshcom",
  meshtastic: "meshtastic",
};

/**
 * The transport to record for an ingested packet. A batch signed by an operator's device key came from
 * the browser RF bridge, whatever port it names. The verify engine never branches on it; its only effect
 * on trust is through {@link provenanceOf}, which attests the on-air transports alone.
 */
export function transportForPort(port: string, signed: boolean): Transport {
  if (signed) return "browser-rf";
  return Object.hasOwn(PORT_TRANSPORT, port) ? PORT_TRANSPORT[port]! : "unknown";
}

/** How a stored position reached us. A value that names no known transport reads as `unknown`, never attested. */
function transportOf(p: RawProvenance): Transport {
  const stored = TransportEnum.safeParse(p.transport);
  return stored.success ? stored.data : "unknown";
}

/**
 * Derive provenance for a stored position. `firstPartyAttested` requires an on-air transport (the
 * operator's own TNC or MeshCom node), an RF hearing, and a receiving site named on the operator
 * allowlist (`attestedSites`). An empty (or absent) allowlist attests nothing. An APRS-IS copy — a
 * `qAR,<attested site>` line included — is never attested.
 */
export function provenanceOf(p: RawProvenance, attestedSites?: Set<string>): Provenance {
  const qConstruct = qConstructOf(p.path);
  const igate = (p.igate_call ?? "").toUpperCase();
  const rfOriginated = p.heard_via === "rf" && (!qConstruct || RF_QCONSTRUCT.test(qConstruct));
  const siteOk = !!attestedSites && attestedSites.size > 0 && !!igate && attestedSites.has(igate);
  const transport = transportOf(p);
  const firstPartyAttested = rfOriginated && siteOk && ON_AIR.has(transport) && !NEVER_ATTESTED.has(transport);
  return {
    transport,
    ...(qConstruct ? { qConstruct } : {}),
    firstPartyAttested,
    ...(igate ? { siteId: igate } : {}),
    ...(p.ts != null ? { heardAt: p.ts } : {}),
  };
}
