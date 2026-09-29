// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it, expect } from "vitest";
import { provenanceOf, qConstructOf, parseAttestedSites } from "../src/provenance.js";

describe("provenance — derive firstPartyAttested", () => {
  it("attests a frame the attested site's own TNC heard, with or without a q-construct", () => {
    const sites = parseAttestedSites("OE8XXX");
    const pv = provenanceOf(
      { heard_via: "rf", igate_call: "OE8XXX", path: "WIDE1-1,qAR,OE8XXX", transport: "tnc", ts: 5 },
      sites,
    );
    expect(pv.firstPartyAttested).toBe(true);
    expect(pv.transport).toBe("tnc");
    expect(pv.qConstruct).toBe("qAR");
    expect(pv.siteId).toBe("OE8XXX");
    expect(pv.heardAt).toBe(5);
    expect(
      provenanceOf({ heard_via: "rf", igate_call: "OE8XXX", path: "WIDE1-1,WIDE2-1", transport: "tnc" }, sites)
        .firstPartyAttested,
    ).toBe(true);
    expect(
      provenanceOf({ heard_via: "rf", igate_call: "OE8XXX", path: "WIDE1-1", transport: "meshcom" }, sites)
        .firstPartyAttested,
    ).toBe(true);
  });

  it("does NOT attest an APRS-IS qAR line naming an attested site — anyone with a passcode can inject it", () => {
    const sites = parseAttestedSites("OE8XXX");
    const line = { heard_via: "rf", igate_call: "OE8XXX", path: "WIDE1-1,qAR,OE8XXX" } as const;
    expect(provenanceOf({ ...line, transport: "aprs-is" }, sites).firstPartyAttested).toBe(false);
    expect(provenanceOf({ ...line, transport: null }, sites).firstPartyAttested).toBe(false); // legacy row
    expect(provenanceOf({ ...line, path: "WIDE2-1,qAO,OE8XXX", transport: "aprs-is" }, sites).firstPartyAttested).toBe(
      false,
    );
  });

  it("does NOT attest a browser-rf batch, whose fixes are stored without a receiving site", () => {
    const sites = parseAttestedSites("OE8XXX");
    expect(provenanceOf({ heard_via: "rf", igate_call: null, transport: "browser-rf" }, sites).firstPartyAttested).toBe(
      false,
    );
    expect(
      provenanceOf({ heard_via: "rf", igate_call: "OE8XXX", transport: "browser-rf" }, sites).firstPartyAttested,
    ).toBe(false);
  });

  it("does NOT attest a bare firehose qAR when no allowlist is configured (default-deny)", () => {
    // The firehose carries frames gated by arbitrary IGates; a qAR alone is not proof this operator
    // heard it. Without an explicit FIRST_PARTY_SITES the fix must stay below Tier A.
    const pv = provenanceOf({ heard_via: "rf", igate_call: "OE8XXX", path: "WIDE1-1,qAR,OE8XXX", ts: 5 });
    expect(pv.firstPartyAttested).toBe(false);
    expect(pv.siteId).toBe("OE8XXX");
    // an empty allowlist is treated the same as none
    expect(
      provenanceOf({ heard_via: "rf", igate_call: "OE8XXX", path: "WIDE1-1,qAR,OE8XXX" }, parseAttestedSites(""))
        .firstPartyAttested,
    ).toBe(false);
  });

  it("does NOT attest an injected (qAC) APRS-IS beacon — transport laundering blocked", () => {
    const pv = provenanceOf({ heard_via: "aprs_is", igate_call: "OE8XXX", path: "TCPIP*,qAC,T2" });
    expect(pv.firstPartyAttested).toBe(false);
  });

  it("does NOT attest an RF fix with no gating site, even with an allowlist set", () => {
    const sites = parseAttestedSites("OE8MINE");
    expect(provenanceOf({ heard_via: "rf", igate_call: null, path: "WIDE1-1,qAR" }, sites).firstPartyAttested).toBe(
      false,
    );
  });

  it("does NOT attest an app-geo fix (that is the Tier-B path, not Tier A)", () => {
    const pv = provenanceOf({ heard_via: "app", path: "" });
    expect(pv.firstPartyAttested).toBe(false);
    expect(pv.transport).toBe("app");
  });

  it("narrows attestation to the operator allowlist when one is set", () => {
    const sites = parseAttestedSites("OE8MINE, OE8ALSO");
    expect(
      provenanceOf({ heard_via: "rf", igate_call: "OE8XXX", path: "WIDE1-1,qAR,OE8XXX" }, sites).firstPartyAttested,
    ).toBe(false);
    expect(
      provenanceOf({ heard_via: "rf", igate_call: "OE8MINE", path: "WIDE1-1", transport: "tnc" }, sites)
        .firstPartyAttested,
    ).toBe(true);
  });

  it("pulls the q-construct out of a stored path", () => {
    expect(qConstructOf("WIDE1-1,qAR,OE8XXX")).toBe("qAR");
    expect(qConstructOf("TCPIP*,qAC,T2")).toBe("qAC");
    expect(qConstructOf("WIDE1-1")).toBeUndefined();
  });

  it("does NOT attest an AXUDP-tunnelled frame — transport laundering blocked", () => {
    // apps/ingest normalises an AXUDP datagram to heard_via:'aprs_is' with a bare AX.25 path (no qAR)
    // and no gating igate → the tunnelled frame can never reach Tier A, however it was transported.
    const pv = provenanceOf({ heard_via: "aprs_is", igate_call: null, path: "WIDE1-1,WIDE2-1" });
    expect(pv.firstPartyAttested).toBe(false);
  });
});

describe("provenance — a local receiving site stamped by the ingest box", () => {
  // A KISS or MeshCom frame heard directly carries the box's site call as igate_call and no q-construct.
  it("attests a direct hearing whose site is in FIRST_PARTY_SITES", () => {
    const pv = provenanceOf(
      { heard_via: "rf", igate_call: "OE8APR-10", path: "WIDE1-1,WIDE2-1", transport: "tnc" },
      parseAttestedSites("OE8APR-10"),
    );
    expect(pv.firstPartyAttested).toBe(true);
    expect(pv.siteId).toBe("OE8APR-10");
  });
  it("does not attest a digipeated frame, which the box stores without a site", () => {
    const pv = provenanceOf(
      { heard_via: "rf", igate_call: null, path: "OE8XBM-10*,WIDE2-1", transport: "tnc" },
      parseAttestedSites("OE8APR-10"),
    );
    expect(pv.firstPartyAttested).toBe(false);
  });
  it("does not attest a site the operator has not listed", () => {
    const pv = provenanceOf(
      { heard_via: "rf", igate_call: "OE8APR-10", path: "", transport: "tnc" },
      parseAttestedSites("OE8XXX"),
    );
    expect(pv.firstPartyAttested).toBe(false);
  });
});
