// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it, expect } from "vitest";
import { decodeMeshcom, meshcomToAprs, meshcomTransportHint } from "@aprscaching/aprs";
import { provenanceOf, parseAttestedSites } from "../src/provenance.js";

/**
 * MeshCom frames reach Tier A only as a direct LoRa hearing at an operator-attested receiving node. These
 * tests drive the MeshCom core's transport hint through the gateway's own provenance derivation — the
 * single Tier-A gate — exactly as a stored position row would be.
 */
const RECEIVER = "OE8APR-12";
const ATTESTED = parseAttestedSites(RECEIVER);

function attested(datagram: object, sites = ATTESTED, receiver = RECEIVER): boolean {
  const r = decodeMeshcom(JSON.stringify(datagram), { receiverCalls: [receiver] });
  if (!r.ok) throw new Error(r.reason);
  const hint = meshcomTransportHint(r.event.provenance, receiver);
  const aprs = meshcomToAprs(r.event)!;
  return provenanceOf(
    { heard_via: hint.heardVia, igate_call: hint.igateCall ?? null, path: aprs.path.join(","), ts: 1 },
    sites,
  ).firstPartyAttested;
}

const POS = {
  src_type: "lora",
  type: "pos",
  src: "DH1FR-1",
  lat: 46.62,
  lat_dir: "N",
  long: 14.3,
  long_dir: "E",
  msg_id: "0A1B2C3D",
  rssi: -100,
  snr: 6,
};

describe("MeshCom trust — no path from internet, relayed or unattested frames to Tier A", () => {
  it("a direct LoRa hearing at an attested receiver is Tier-A eligible", () => {
    expect(attested(POS)).toBe(true);
  });

  it("a server-relayed (udp) frame never is", () => {
    expect(attested({ ...POS, src_type: "udp" })).toBe(false);
  });

  it("the node's own traffic never is", () => {
    expect(attested({ ...POS, src_type: "node" })).toBe(false);
  });

  it("a relayed LoRa frame never is, even at an attested receiver", () => {
    expect(attested({ ...POS, src: "DH1FR-1,OE1XOR-12" })).toBe(false);
  });

  it("a direct hearing at a receiver that is not attested never is", () => {
    expect(attested(POS, parseAttestedSites("OE9XYZ"))).toBe(false);
    expect(attested(POS, parseAttestedSites(""))).toBe(false);
  });

  it("the receiver's own back-pressure notice never is, although the firmware labels it lora", () => {
    expect(attested({ ...POS, src: RECEIVER, rssi: 0, snr: 0 })).toBe(false);
  });
});
