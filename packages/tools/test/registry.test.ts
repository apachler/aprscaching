// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import {
  validateManifest, signManifest, checkManifestSignature, signRegistry, verifyRegistry,
  resolveTrust, bytesToB64, type RegistryEntry, type ToolManifest,
} from "../src/index.js";

async function genKeys() {
  const kp = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const rawPub = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
  return { priv: kp.privateKey, pubB64url: bytesToB64(rawPub, true) };
}
function manifest(input: Record<string, unknown>): ToolManifest {
  const r = validateManifest(input);
  if (!r.ok) throw new Error(r.error);
  return r.manifest;
}

describe("manifest signing", () => {
  it("signs + verifies; tampering or the wrong key invalidates it; no sig = unsigned", async () => {
    const { priv, pubB64url } = await genKeys();
    const base = manifest({ name: "sig-tool", title: "Signed", author: "OE8APR", version: "1.0", permissions: ["command"], pubkey: pubB64url });
    expect(await checkManifestSignature(base)).toBe("unsigned");
    const signed = await signManifest(base, priv);
    expect(await checkManifestSignature(signed)).toBe("valid");
    // tamper a signed field → signature no longer matches
    const tampered = { ...signed, permissions: [...signed.permissions, "tx"] } as ToolManifest;
    expect(await checkManifestSignature(tampered)).toBe("invalid");
    // a signature made by a different key than the manifest's pubkey
    const other = await genKeys();
    const mismatched = await signManifest(manifest({ name: "mm", title: "M", author: "X", version: "1", permissions: [], pubkey: other.pubB64url }), priv);
    expect(await checkManifestSignature(mismatched)).toBe("invalid");
  });
});

describe("signed registry (marketplace index)", () => {
  it("verifies against the pinned authority; rejects a wrong authority or edited entries", async () => {
    const auth = await genKeys();
    const entries: RegistryEntry[] = [{ name: "t", title: "T", author: "OE8APR", version: "1", pubkey: "AAAA", entry: "https://x/tool.json" }];
    const reg = await signRegistry(entries, auth.pubB64url, auth.priv);
    expect(await verifyRegistry(reg, auth.pubB64url)).toBe(true);
    expect(await verifyRegistry(reg, "someOtherAuthorityKey")).toBe(false);          // pinned mismatch
    expect(await verifyRegistry({ ...reg, entries: [...entries, { ...entries[0]!, name: "evil" }] }, auth.pubB64url)).toBe(false); // entries edited after signing
  });
});

describe("resolveTrust", () => {
  it("maps signature + registry/pin state to a trust label", () => {
    expect(resolveTrust("invalid", {})).toBe("invalid");
    expect(resolveTrust("unsigned", {})).toBe("unsigned");
    expect(resolveTrust("valid", { pubkey: "K", registryPubkey: "K" })).toBe("verified");
    expect(resolveTrust("valid", { pubkey: "K", registryPubkey: "OTHER" })).toBe("key-changed");
    expect(resolveTrust("valid", { pubkey: "K", pinnedPubkey: "K" })).toBe("known");
    expect(resolveTrust("valid", { pubkey: "K", pinnedPubkey: "OTHER" })).toBe("key-changed");
    expect(resolveTrust("valid", { pubkey: "K" })).toBe("self-signed");
  });
});
