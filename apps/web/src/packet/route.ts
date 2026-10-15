// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The legs of a stored packet's route, in the order it travelled them, and why it counts for the tier it does.
 * Pure: the PacketRoute component draws what this returns, and the tests pin it.
 *
 * Trust follows the receiver, never the transport: only a frame an attested site's own receiver heard, delivered
 * by that site's own ingest (`attested`), counts toward Tier A. Every APRS-IS line stays Tier C, one whose
 * q-construct names an attested site (`qAR,<site>`) included, since anyone with a public passcode can write it.
 */
import { isRfQConstruct, splitPath } from "@aprscaching/aprs";
import type { PacketRouteInfo } from "@aprscaching/shared";
import type { TERMS } from "../terms.js";

/** What a leg of the route is. */
export type HopRole = "origin" | "digipeater" | "internet" | "receiver" | "igate" | "aprs-is" | "gateway";

/**
 * How a leg bears on trust: `attested` an attested site's own receiver, `untrusted` a leg that keeps the packet
 * at Tier C, `unused` a digipeater request no station took, `plain` everything else.
 */
export type HopState = "plain" | "attested" | "untrusted" | "unused";

export interface RouteHop {
  role: HopRole;
  /** The leg's role in a word or two: "Sender", "Digipeater", "IGate", "APRS-IS". */
  label: string;
  /** The station, request or construct at this leg (mono on screen); absent for the instance itself. */
  call?: string;
  /** A second detail line (the server a q-construct names, the transport). */
  sub?: string;
  state: HopState;
  /** The glossary term that explains this leg, for its InfoTip. */
  term?: keyof typeof TERMS;
}

export interface RouteView {
  hops: RouteHop[];
  /** The tier this packet can support on its own: A only for an attested hearing. */
  evidence: "A" | "C";
  /** One line on why. */
  why: string;
}

/** How each non-APRS-IS transport reads on screen. */
const TRANSPORT_NAME: Record<string, string> = {
  tnc: "TNC",
  meshcom: "MeshCom",
  "browser-rf": "browser radio bridge",
  axudp: "AXUDP link",
  axip: "AXIP link",
  meshtastic: "Meshtastic",
  "hamnet-kiss": "HAMNET link",
  "aprs-is": "APRS-IS",
};

/** Transports that are internet links or a licence-free carrier: never an RF hearing of this instance's. */
const OFF_AIR = new Set(["axudp", "axip", "meshtastic", "hamnet-kiss"]);

/** The legs of `r` and the reason for its tier. */
export function routeView(r: PacketRouteInfo): RouteView {
  const p = splitPath(r.path);
  const hops: RouteHop[] = [{ role: "origin", label: "Sender", call: r.src, state: "plain" }];

  for (const d of p.digis) {
    if (!d.used) {
      hops.push({ role: "digipeater", label: "Not taken", call: d.call, state: "unused", term: "digipeater" });
    } else {
      hops.push({
        role: "digipeater",
        label: d.generic ? "Path request, used" : "Digipeater",
        call: d.call,
        state: "plain",
        term: "digipeater",
      });
    }
  }
  if (p.internet)
    hops.push({ role: "internet", label: "Sent to APRS-IS", call: "TCPIP", state: "untrusted", term: "aprs-is" });

  const site = r.site ?? undefined;
  let why: string;
  if (r.attested) {
    hops.push({
      role: "receiver",
      label: "Attested receiver",
      call: site,
      sub: TRANSPORT_NAME[r.transport] ?? r.transport,
      state: "attested",
      term: "attested-site",
    });
    why = `Heard on the air by ${site ?? "an attested site"}'s own receiver, which this instance attests: it counts toward Tier A.`;
  } else if (p.q) {
    const rf = isRfQConstruct(p.q);
    const via = p.qVia.join(", ");
    if (rf) hops.push({ role: "igate", label: "IGate", call: p.qVia[0] ?? site, state: "plain", term: "igate" });
    hops.push({
      role: "aprs-is",
      label: "APRS-IS",
      call: p.q,
      ...(!rf && via ? { sub: `server ${via}` } : {}),
      state: "untrusted",
      term: "q-construct",
    });
    const named = p.qVia[0] ?? site;
    why =
      rf && r.siteAttested
        ? `It came as an APRS-IS line naming ${named}, an attested site. Anyone with a public passcode can write ${p.q}, so it stays Tier C.`
        : rf
          ? `${named ?? "An IGate"} copied it to APRS-IS (${p.q}). No receiver this instance attests heard it, so it stays Tier C.`
          : p.internet
            ? `The sender wrote it straight to APRS-IS (${p.q}); it was never heard on the air here, so it stays Tier C.`
            : `It arrived over APRS-IS (${p.q}); no receiver this instance attests heard it, so it stays Tier C.`;
  } else if (r.transport === "browser-rf") {
    hops.push({ role: "receiver", label: "Own radio bridge", sub: "browser radio bridge", state: "untrusted" });
    why =
      "The sender's own browser radio bridge delivered it: that shows who sent it, not that an independent station heard it, so it stays Tier C.";
  } else if (OFF_AIR.has(r.transport)) {
    const name = TRANSPORT_NAME[r.transport] ?? r.transport;
    hops.push({ role: "receiver", label: "Link", call: site, sub: name, state: "untrusted", term: "axudp" });
    why = `It came over a ${name}, not a receiver this instance attests on amateur RF, so it stays Tier C.`;
  } else if (r.heardVia === "rf") {
    hops.push({
      role: "receiver",
      label: "Receiver",
      call: site,
      sub: TRANSPORT_NAME[r.transport] ?? r.transport,
      state: "untrusted",
      term: "attested-site",
    });
    why = `Heard on the air by ${site ?? "a receiver"}, which this instance does not attest, so it stays Tier C.`;
  } else {
    hops.push({ role: "aprs-is", label: "APRS-IS", state: "untrusted", term: "aprs-is" });
    why =
      "It arrived over APRS-IS with no q-construct; no receiver this instance attests heard it, so it stays Tier C.";
  }

  hops.push({ role: "gateway", label: "This instance", state: "plain" });
  return { hops, evidence: r.attested ? "A" : "C", why };
}
