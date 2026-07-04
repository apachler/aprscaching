// SPDX-License-Identifier: MIT
// The wire format's invariants: the envelope round-trips typed records byte-deterministically, the
// signing bytes carry the domain-separation prefix (no cross-protocol replay), coordinates travel as
// 1e-7-degree integers, endpoint addresses validate per transport, and capability negotiation
// resolves to the slower/smaller/common profile.
import { describe, it, expect } from "vitest";
import {
  FED_DOMAIN,
  encodeFedPayload,
  decodeFedPayload,
  fedSigningBytes,
  encodeFedFrame,
  decodeFedFrame,
  toE7,
  fromE7,
  FedEndpoint,
  parseEndpoints,
  validEndpointAddress,
  is44netName,
  negotiateCaps,
  tierForRateClass,
  type FedRecord,
  type LinkCaps,
} from "../src/fedwire.js";

const record: FedRecord = {
  kind: "cache",
  gid: "oe.pub:cache:42",
  origin: "oe.pub",
  v: 3,
  at: 1_760_000_000,
  signer: "oe.pub",
  body: { code: "ACS-042", title: "Schlossberg", latE7: toE7(47.0832), lonE7: toE7(15.4232), status: "active" },
};

describe("fedwire envelope + frame", () => {
  it("round-trips a record through payload encode/decode", () => {
    const payload = encodeFedPayload(record);
    expect(decodeFedPayload(payload)).toEqual(record);
  });

  it("is byte-deterministic regardless of body key insertion order", () => {
    const shuffled: FedRecord = {
      ...record,
      body: { status: "active", lonE7: toE7(15.4232), latE7: toE7(47.0832), title: "Schlossberg", code: "ACS-042" },
    };
    expect(encodeFedPayload(shuffled)).toEqual(encodeFedPayload(record));
  });

  it("prefixes the signing bytes with the domain tag — cross-protocol replay is impossible", () => {
    const payload = encodeFedPayload(record);
    const signed = fedSigningBytes(payload);
    expect(new TextDecoder().decode(signed.slice(0, FED_DOMAIN.length))).toBe(FED_DOMAIN);
    expect(signed.slice(FED_DOMAIN.length)).toEqual(payload);
  });

  it("frames and re-parses payload + key + signature verbatim", () => {
    const payload = encodeFedPayload(record);
    const sig = new Uint8Array(64).fill(7);
    const frame = encodeFedFrame(payload, "PUBKEY_B64URL", sig);
    const parsed = decodeFedFrame(frame);
    expect(parsed.payload).toEqual(payload); // verbatim bytes — verify against these, never a re-encode
    expect(parsed.signerKey).toBe("PUBKEY_B64URL");
    expect(parsed.sig).toEqual(sig);
    expect(parsed.record.gid).toBe("oe.pub:cache:42");
  });

  it("rejects a payload with a fractional number in the body", () => {
    expect(() => encodeFedPayload({ ...record, body: { lat: 47.0832 } })).toThrow(/scale to an integer/);
  });

  it("rejects unknown record types and missing envelope fields", () => {
    expect(() => encodeFedPayload({ ...record, kind: "nope" as never })).toThrow(/unknown record kind/);
    const truncated = encodeFedPayload(record).slice(0, 10);
    expect(() => decodeFedPayload(truncated)).toThrow();
  });
});

describe("E7 coordinates", () => {
  it("round-trips at ~1 cm resolution and rejects out-of-range", () => {
    expect(fromE7(toE7(47.0832156))).toBeCloseTo(47.0832156, 7);
    expect(toE7(-180)).toBe(-1_800_000_000);
    expect(() => toE7(181)).toThrow(/out of range/);
    expect(() => toE7(NaN)).toThrow(/out of range/);
  });
});

describe("typed peer endpoints", () => {
  it("validates addresses per transport kind", () => {
    expect(validEndpointAddress("https", "https://aprscaching.example.net")).toBe(true);
    expect(validEndpointAddress("https", "not a url")).toBe(false);
    expect(validEndpointAddress("44net", "oe8apr.ampr.org")).toBe(true);
    expect(validEndpointAddress("44net", "44.143.1.1")).toBe(false); // a NAME, never a raw address
    expect(validEndpointAddress("ax25", "OE8APR-7")).toBe(true);
    expect(validEndpointAddress("ax25", "TOOLONGCALL-99")).toBe(false);
    expect(validEndpointAddress("netrom", "ACSNOD")).toBe(true);
    expect(validEndpointAddress("bbs", "OE8APR@OE8XBB.#KTN.AUT.EU")).toBe(true);
    expect(validEndpointAddress("bbs", "no-at-sign")).toBe(false);
  });

  it("parses stored endpoint lists, dropping malformed entries, sorted by priority", () => {
    const eps = parseEndpoints([
      { transport: "ax25", address: "OE8APR-7", priority: 30 },
      { transport: "44net", address: "oe8apr.ampr.org", priority: 10, verifiedVia: "ardc-lot" },
      { transport: "https", address: "::::", priority: 1 }, // malformed — dropped, not fatal
      { transport: "https", address: "https://acs.oe8apr.net", priority: 20 },
    ]);
    expect(eps.map((e) => e.transport)).toEqual(["44net", "https", "ax25"]);
    expect(eps[0]!.verifiedVia).toBe("ardc-lot");
  });

  it("flags the ARDC-attestable namespace", () => {
    expect(is44netName("oe8apr.ampr.org")).toBe(true);
    expect(is44netName("oe8apr.evil.example")).toBe(false);
  });

  it("zod-validates a single endpoint", () => {
    expect(FedEndpoint.safeParse({ transport: "44net", address: "oe8apr.ampr.org" }).success).toBe(true);
    expect(FedEndpoint.safeParse({ transport: "44net", address: "44.143.1.1" }).success).toBe(false);
  });
});

describe("link capability negotiation", () => {
  const ip: LinkCaps = {
    mode: "sync",
    mtu: 65536,
    rateClass: "ipHi",
    batchMax: 500,
    compress: ["deflateDict1", "deflate", "none"],
    recordSet: "full",
  };
  const vhf: LinkCaps = {
    mode: "sync",
    mtu: 2048,
    rateClass: "vhf1200",
    batchMax: 20,
    compress: ["deflate", "none"],
    recordSet: "compact",
  };

  it("intersects to the slower rate, smaller mtu/batch, best common compression, smaller record set", () => {
    const eff = negotiateCaps(ip, vhf)!;
    expect(eff).toEqual({
      mode: "sync",
      mtu: 2048,
      rateClass: "vhf1200",
      batchMax: 20,
      compress: ["deflate", "none"],
      recordSet: "compact",
    });
  });

  it("returns null on mode mismatch or no common compression", () => {
    expect(negotiateCaps(ip, { ...vhf, mode: "forward" })).toBeNull();
    expect(negotiateCaps({ ...ip, compress: ["deflateDict1"] }, { ...vhf, compress: ["none"] })).toBeNull();
  });

  it("maps rate classes to default record-set tiers", () => {
    expect(tierForRateClass("hf")).toBe("beacon");
    expect(tierForRateClass("vhf1200")).toBe("compact");
    expect(tierForRateClass("ipHi")).toBe("full");
  });
});
