// SPDX-License-Identifier: AGPL-3.0-or-later
// Callsign validity from public licence registers: the lookup key a call normalises to, and how several
// register rows for one call resolve to one answer.
import { describe, it, expect } from "vitest";
import { homeCall, resolveLicence, sourceName, type RegistryRow } from "../src/licence.js";

describe("homeCall — the lookup key", () => {
  it("uppercases, trims and strips the SSID and a trailing asterisk", () => {
    expect(homeCall(" w1aw-9 ")).toBe("W1AW");
    expect(homeCall("OE8APR-10*")).toBe("OE8APR");
  });

  it("extracts the home call from portable prefixes and suffixes", () => {
    expect(homeCall("OE/DL1ABC/P")).toBe("DL1ABC");
    expect(homeCall("DL1ABC/OE")).toBe("DL1ABC");
    expect(homeCall("VE3/W1AW")).toBe("W1AW");
    expect(homeCall("KH6/K1ABC/M")).toBe("K1ABC");
    expect(homeCall("W1AW/KH6")).toBe("W1AW");
    expect(homeCall("G4ABC/MM")).toBe("G4ABC");
    expect(homeCall("F/G4ABC/QRP")).toBe("G4ABC");
    expect(homeCall("OE8APR/9-7")).toBe("OE8APR");
  });

  it("returns null for anything without a callsign shape", () => {
    expect(homeCall("")).toBeNull();
    expect(homeCall("OE")).toBeNull();
    expect(homeCall("KH6/P")).toBeNull();
    expect(homeCall("NOCALL")).toBeNull();
    expect(homeCall("A1")).toBeNull();
    expect(homeCall("ABCDEFGHIJ1KLM")).toBeNull();
  });
});

describe("resolveLicence — one answer from the register rows", () => {
  const now = 2_000_000_000;
  const row = (o: Partial<RegistryRow>): RegistryRow => ({
    source: "fcc",
    status: "licensed",
    expires_at: null,
    updated_at: now - 86400,
    ...o,
  });

  it("is unconfirmed when no register lists the call", () => {
    expect(resolveLicence([], now)).toEqual({ status: "unconfirmed" });
  });

  it("is licensed while the listing is current, with the source and import date", () => {
    expect(resolveLicence([row({ expires_at: now + 1000 })], now)).toEqual({
      status: "licensed",
      source: "fcc",
      sourceName: "FCC",
      expiresAt: now + 1000,
      checkedAt: now - 86400,
    });
  });

  it("reads a licensed row past its expiry as expired", () => {
    expect(resolveLicence([row({ expires_at: now - 1 })], now).status).toBe("expired");
  });

  it("prefers a current listing over an expired one from another register", () => {
    const r = resolveLicence([row({ status: "expired", expires_at: now - 5 }), row({ source: "ised" })], now);
    expect(r.status).toBe("licensed");
    expect(r.source).toBe("ised");
  });

  it("names known sources and falls back to the id", () => {
    expect(sourceName("ised")).toBe("ISED Canada");
    expect(sourceName("xy")).toBe("XY");
  });
});
