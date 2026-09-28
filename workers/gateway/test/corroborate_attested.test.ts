// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it, expect } from "vitest";
import { pickLocalEvidence } from "../src/corroborate.js";
import { parseAttestedSites } from "../src/provenance.js";

const Q = { callsign: "OE3RF-9", lat: 47.2, lon: 15.05, radiusM: 150 };
const near = (igate: string | null) => ({ lat: 47.2004, lon: 15.05, ts: 100, igate_call: igate });
const none = new Set<string>();

describe("federation corroboration vouches only through attested sites", () => {
  it("answers from a position heard through an attested site", () => {
    const e = pickLocalEvidence([near("OE8XXX")], Q, none, parseAttestedSites("OE8XXX"));
    expect(e?.igateCall).toBe("OE8XXX");
    expect(e!.distanceM).toBeLessThan(150);
  });

  it("does not answer from a site this instance does not attest", () => {
    expect(pickLocalEvidence([near("DL9ZZZ-10")], Q, none, parseAttestedSites("OE8XXX"))).toBeNull();
  });

  it("vouches for nothing when no site is attested (default-deny, like local Tier A)", () => {
    expect(pickLocalEvidence([near("OE8XXX")], Q, none, parseAttestedSites(""))).toBeNull();
  });

  it("never answers from a position without a receiving site", () => {
    expect(pickLocalEvidence([near(null)], Q, none, parseAttestedSites("OE8XXX"))).toBeNull();
  });

  it("still skips the logger's own site and sites the asker excludes", () => {
    const sites = parseAttestedSites("OE3RF-10,OE8XXX");
    expect(pickLocalEvidence([near("OE3RF-10")], Q, none, sites)).toBeNull();
    expect(pickLocalEvidence([near("OE8XXX")], Q, new Set(["OE8XXX"]), sites)).toBeNull();
  });

  it("ignores attested hearings outside the cache radius", () => {
    const far = { lat: 47.3, lon: 15.05, ts: 100, igate_call: "OE8XXX" };
    expect(pickLocalEvidence([far], Q, none, parseAttestedSites("OE8XXX"))).toBeNull();
  });
});
