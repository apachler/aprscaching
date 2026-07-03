// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it, expect } from "vitest";
import {
  verifyRegistry,
  registryKeyAllowed,
  stableStringify,
  parseRegistryTxt,
  type SignedRegistry,
} from "../src/federation.js";

const b64u = (buf: ArrayBuffer) => {
  let s = "";
  for (const b of new Uint8Array(buf)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

describe("DNS TXT registry anchor (T4.2)", () => {
  it("parses url + key from a k=v;k=v TXT string; ignores junk + non-https", () => {
    expect(parseRegistryTxt('"url=https://oe.aprscaching.net/reg.json; key=ABC123"')).toEqual({
      url: "https://oe.aprscaching.net/reg.json",
      key: "ABC123",
    });
    expect(parseRegistryTxt("key=ONLYKEY")).toEqual({ key: "ONLYKEY" });
    expect(parseRegistryTxt("url=http://insecure; noise; =x")).toEqual({}); // http rejected, junk ignored
    expect(parseRegistryTxt("")).toEqual({});
  });
});

describe("signed instance registry (F7/T4.2)", () => {
  it("verifies an authority-signed registry, rejects tampering + a wrong authority", async () => {
    const auth = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
    const other = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
    const authX = b64u(await crypto.subtle.exportKey("raw", auth.publicKey));
    const otherX = b64u(await crypto.subtle.exportKey("raw", other.publicKey));
    const entries = [{ instance: "oe.net", url: "https://oe.aprscaching.net", key: "PEERKEY" }];
    const at = 100;
    const sig = b64u(
      await crypto.subtle.sign("Ed25519", auth.privateKey, new TextEncoder().encode(stableStringify({ at, entries }))),
    );
    const doc: SignedRegistry = { entries, at, sig };

    expect(await verifyRegistry(doc, authX)).toBe(true);
    expect(await verifyRegistry(doc, otherX)).toBe(false); // wrong authority
    expect(await verifyRegistry({ ...doc, at: 101 }, authX)).toBe(false); // tampered payload
    expect(await verifyRegistry({ entries, at } as SignedRegistry, authX)).toBe(false); // unsigned
  });

  it("the anti-spoof binding allows the registered key, rejects an impostor, TOFUs the unregistered", () => {
    const entry = { instance: "oe.net", key: "GOOD" };
    expect(registryKeyAllowed(entry, ["GOOD", "old"])).toBe(true); // peer presents the bound key
    expect(registryKeyAllowed(entry, ["EVIL"])).toBe(false); // impersonation — bound key absent
    expect(registryKeyAllowed(undefined, ["anything"])).toBe(true); // unregistered → TOFU
    expect(registryKeyAllowed({ instance: "x" }, ["k"])).toBe(true); // registered but no bound key → TOFU
  });
});
