// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it, expect } from "vitest";
import { provenanceOf, qConstructOf, parseAttestedSites } from "../src/provenance.js";

describe("provenance — derive firstPartyAttested (docs/design/22)", () => {
  it("attests an RF fix with a qAR construct and an independent gating site", () => {
    const pv = provenanceOf({ heard_via: "rf", igate_call: "OE8XXX", path: "WIDE1-1,qAR,OE8XXX", ts: 5 });
    expect(pv.firstPartyAttested).toBe(true);
    expect(pv.transport).toBe("aprs-is");
    expect(pv.qConstruct).toBe("qAR");
    expect(pv.siteId).toBe("OE8XXX");
    expect(pv.heardAt).toBe(5);
  });

  it("does NOT attest an injected (qAC) APRS-IS beacon — transport laundering blocked", () => {
    const pv = provenanceOf({ heard_via: "aprs_is", igate_call: "OE8XXX", path: "TCPIP*,qAC,T2" });
    expect(pv.firstPartyAttested).toBe(false);
  });

  it("does NOT attest an RF fix with no gating site", () => {
    expect(provenanceOf({ heard_via: "rf", igate_call: null, path: "WIDE1-1,qAR" }).firstPartyAttested).toBe(false);
  });

  it("does NOT attest an app-geo fix (that is the Tier-B path, not Tier A)", () => {
    const pv = provenanceOf({ heard_via: "app", path: "" });
    expect(pv.firstPartyAttested).toBe(false);
    expect(pv.transport).toBe("app");
  });

  it("narrows attestation to the operator allowlist when one is set", () => {
    const sites = parseAttestedSites("OE8MINE, OE8ALSO");
    expect(provenanceOf({ heard_via: "rf", igate_call: "OE8XXX", path: "WIDE1-1,qAR,OE8XXX" }, sites).firstPartyAttested).toBe(false);
    expect(provenanceOf({ heard_via: "rf", igate_call: "OE8MINE", path: "WIDE1-1,qAR,OE8MINE" }, sites).firstPartyAttested).toBe(true);
  });

  it("pulls the q-construct out of a stored path", () => {
    expect(qConstructOf("WIDE1-1,qAR,OE8XXX")).toBe("qAR");
    expect(qConstructOf("TCPIP*,qAC,T2")).toBe("qAC");
    expect(qConstructOf("WIDE1-1")).toBeUndefined();
  });

  it("does NOT attest an AXUDP-tunnelled frame — transport laundering blocked (docs/design/22 reserved seam)", () => {
    // apps/ingest normalises an AXUDP datagram to heard_via:'aprs_is' with a bare AX.25 path (no qAR)
    // and no gating igate → the tunnelled frame can never reach Tier A, however it was transported.
    const pv = provenanceOf({ heard_via: "aprs_is", igate_call: null, path: "WIDE1-1,WIDE2-1" });
    expect(pv.firstPartyAttested).toBe(false);
  });
});
