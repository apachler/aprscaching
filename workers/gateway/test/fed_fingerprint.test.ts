// SPDX-License-Identifier: AGPL-3.0-or-later
// The federation key fingerprint two sysops compare out of band. deploy/test/helpers-test.sh checks that the
// doctor prints the same value for the same key.
import { describe, it, expect } from "vitest";
import { keyFingerprint, ownKeyFingerprint } from "../src/federation.js";
import type { Env } from "../src/env.js";

/** The raw key 00 01 … 1f: SHA-256 starts 630dcd2966c43366. */
const KEY = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";

describe("keyFingerprint", () => {
  it("is the first 64 bits of SHA-256 over the raw key, in four groups of four hex digits", async () => {
    expect(await keyFingerprint(KEY)).toBe("630d cd29 66c4 3366");
  });

  it("differs for a key one bit apart", async () => {
    const other = "AQECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";
    expect(await keyFingerprint(other)).not.toBe(await keyFingerprint(KEY));
  });

  it("is null for no key, a key of the wrong length, or garbage", async () => {
    expect(await keyFingerprint(null)).toBeNull();
    expect(await keyFingerprint("")).toBeNull();
    expect(await keyFingerprint("AAEC")).toBeNull();
    expect(await keyFingerprint("not base64 !!")).toBeNull();
  });

  it("an instance without FED_PRIVATE_KEY has no fingerprint of its own", async () => {
    expect(await ownKeyFingerprint({} as Env)).toBeNull();
  });
});
