// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it, expect } from "vitest";
import { corroboratorIgate } from "../src/corroborate.js";

describe("corroboratorIgate — who to credit for a Tier-A find (docs/13 + docs/15)", () => {
  it("credits the gating IGate of a locally verified find", () => {
    expect(corroboratorIgate({ method: "aprs_rf", matchedIgate: "OE8XXX", loggerCall: "OE3RF" })).toBe("OE8XXX");
  });

  it("credits a peer's revealed IGate for a cross-instance corroboration", () => {
    expect(corroboratorIgate({ method: "aprs_rf_peer", peerIgate: "DL9PEER-10", loggerCall: "OE3RF" })).toBe("DL9PEER-10");
  });

  it("credits nobody when a peer did not reveal its IGate (privacy default)", () => {
    expect(corroboratorIgate({ method: "aprs_rf_peer", peerIgate: null, loggerCall: "OE3RF" })).toBeNull();
  });

  it("never self-credits (the IGate is the logger's own call)", () => {
    expect(corroboratorIgate({ method: "aprs_rf", matchedIgate: "OE3RF-1", loggerCall: "OE3RF" })).toBeNull();
  });

  it("uppercases the credited callsign", () => {
    expect(corroboratorIgate({ method: "aprs_rf", matchedIgate: "oe8xxx", loggerCall: "OE3RF" })).toBe("OE8XXX");
  });

  it("app/IS finds (no RF IGate) credit nobody", () => {
    expect(corroboratorIgate({ method: "app_geo", matchedIgate: null, loggerCall: "OE3RF" })).toBeNull();
  });
});
