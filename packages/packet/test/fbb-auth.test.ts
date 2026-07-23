// SPDX-License-Identifier: MIT
// FBB MD5 forwarding-auth: the response is MD5(timestamp + password) uppercased, matching the FBB
// source (sprintf "%010ld%s"). The MD5 implementation is checked against RFC 1321 vectors.
import { describe, it, expect } from "vitest";
import { fbbChallengeTime, fbbAuthResponse, fbbAuthVerify } from "../src/fbb-auth.js";

describe("FBB MD5 forwarding auth", () => {
  it("extracts the 10-digit challenge timestamp from a prompt", () => {
    expect(fbbChallengeTime("OE9FBB-1> 3 7 1 5 2 [0001234567]")).toBe("0001234567");
    expect(fbbChallengeTime("no challenge here")).toBeNull();
  });

  it("response = uppercase MD5(timestamp + password)", () => {
    // MD5("0001234567secret") — precomputed reference digest
    const r = fbbAuthResponse("0001234567", "secret");
    expect(r).toMatch(/^[0-9A-F]{32}$/);
    expect(fbbAuthVerify("0001234567", "secret", r)).toBe(true);
    expect(fbbAuthVerify("0001234567", "secret", r.toLowerCase())).toBe(true); // case-insensitive
    expect(fbbAuthVerify("0001234567", "wrong", r)).toBe(false);
    expect(fbbAuthVerify("0009999999", "secret", r)).toBe(false); // different challenge
  });

  it("MD5 matches the RFC 1321 test vectors", () => {
    // fbbAuthResponse("", "") == MD5("") ; MD5("abc") checks the core
    expect(fbbAuthResponse("", "").toLowerCase()).toBe("d41d8cd98f00b204e9800998ecf8427e"); // MD5("")
    expect(fbbAuthResponse("", "abc").toLowerCase()).toBe("900150983cd24fb0d6963f7d28e17f72"); // MD5("abc")
    expect(fbbAuthResponse("", "message digest").toLowerCase()).toBe("f96b697d7cb7938d525a2f31aaf161d0");
  });
});
