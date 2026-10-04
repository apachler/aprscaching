// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it, expect } from "vitest";
import { pickLocalEvidence } from "../src/corroborate.js";
import { parseAttestedSites } from "../src/provenance.js";

const Q = { callsign: "OE3RF-9", lat: 47.2, lon: 15.05, radiusM: 150 };
const near = (igate: string | null, transport: string | null = "tnc") => ({
  lat: 47.2004,
  lon: 15.05,
  ts: 100,
  heard_via: "rf",
  igate_call: igate,
  path: "WIDE1-1",
  transport,
});
const none = new Set<string>();

describe("federation corroboration vouches only through attested sites", () => {
  it("answers from a position heard through an attested site", () => {
    const e = pickLocalEvidence([near("OE8XXX")], Q, none, parseAttestedSites("OE8XXX"));
    expect(e?.igateCall).toBe("OE8XXX");
    expect(e!.distanceM).toBeLessThan(150);
  });

  it("does not answer from an APRS-IS qAR copy naming an attested site", () => {
    const sites = parseAttestedSites("OE8XXX");
    const isCopy = { ...near("OE8XXX", "aprs-is"), path: "WIDE1-1,qAR,OE8XXX" };
    expect(pickLocalEvidence([isCopy], Q, none, sites)).toBeNull();
    expect(pickLocalEvidence([{ ...isCopy, transport: null }], Q, none, sites)).toBeNull(); // legacy row
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
    const far = { ...near("OE8XXX"), lat: 47.3 };
    expect(pickLocalEvidence([far], Q, none, parseAttestedSites("OE8XXX"))).toBeNull();
  });
});

describe("a site trusted through an enrolled box", () => {
  const attested = { shared: parseAttestedSites("OE8XXX"), byBox: new Map([["lent-1", new Set(["OE3LND-10"])]]) };

  it("vouches only through the positions that box delivered", () => {
    const viaBox = { ...near("OE3LND-10"), ingest_box: "lent-1" };
    expect(pickLocalEvidence([viaBox], Q, none, attested)?.igateCall).toBe("OE3LND-10");
    expect(pickLocalEvidence([{ ...viaBox, ingest_box: "other-1" }], Q, none, attested)).toBeNull();
    expect(pickLocalEvidence([{ ...viaBox, ingest_box: null }], Q, none, attested)).toBeNull();
  });

  it("leaves the instance's own sites to the shared secret's deliveries", () => {
    expect(pickLocalEvidence([{ ...near("OE8XXX"), ingest_box: null }], Q, none, attested)?.igateCall).toBe("OE8XXX");
    expect(pickLocalEvidence([{ ...near("OE8XXX"), ingest_box: "lent-1" }], Q, none, attested)).toBeNull();
  });
});
