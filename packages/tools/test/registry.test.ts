// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import {
  validateManifest,
  signManifest,
  checkManifestSignature,
  signRegistry,
  verifyRegistry,
  resolveTrust,
  registryEntryFor,
  bytesToB64,
  type RegistryEntry,
  type ToolManifest,
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
    const base = manifest({
      name: "sig-tool",
      title: "Signed",
      author: "OE8APR",
      version: "1.0",
      api: "1.0",
      permissions: ["command"],
      pubkey: pubB64url,
    });
    expect(await checkManifestSignature(base)).toBe("unsigned");
    const signed = await signManifest(base, priv);
    expect(await checkManifestSignature(signed)).toBe("valid");
    // tamper a signed field → signature no longer matches
    const tampered = { ...signed, permissions: [...signed.permissions, "tx"] } as ToolManifest;
    expect(await checkManifestSignature(tampered)).toBe("invalid");
    // a signature made by a different key than the manifest's pubkey
    const other = await genKeys();
    const mismatched = await signManifest(
      manifest({
        name: "mm",
        title: "M",
        author: "X",
        version: "1",
        api: "1.0",
        permissions: [],
        pubkey: other.pubB64url,
      }),
      priv,
    );
    expect(await checkManifestSignature(mismatched)).toBe("invalid");
  });
});

describe("signed registry (marketplace index)", () => {
  it("verifies against the pinned authority; rejects a wrong authority or edited entries", async () => {
    const auth = await genKeys();
    const entries: RegistryEntry[] = [
      {
        name: "t",
        title: "T",
        author: "OE8APR",
        version: "1",
        api: "1.0",
        pubkey: "AAAA",
        entry: "https://x/tool.json",
      },
    ];
    const reg = await signRegistry(entries, auth.pubB64url, auth.priv);
    expect(await verifyRegistry(reg, auth.pubB64url)).toBe(true);
    expect(await verifyRegistry(reg, "someOtherAuthorityKey")).toBe(false); // pinned mismatch
    expect(
      await verifyRegistry({ ...reg, entries: [...entries, { ...entries[0]!, name: "evil" }] }, auth.pubB64url),
    ).toBe(false); // entries edited after signing
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

describe("registryEntryFor", () => {
  const listed: RegistryEntry = {
    name: "cw-tool",
    title: "CW",
    author: "OE8APR",
    version: "1",
    api: "1.0",
    pubkey: "K",
    entry: "https://tools.example.org/cw-tool/tool.json",
  };
  const trustFor = (url: string) =>
    resolveTrust("valid", { pubkey: "K", registryPubkey: registryEntryFor([listed], "cw-tool", url)?.pubkey });

  it("matches the listed manifest fetched from the registry's URL", () => {
    expect(registryEntryFor([listed], "cw-tool", "https://tools.example.org/cw-tool/tool.json")).toBe(listed);
    expect(trustFor("https://tools.example.org/cw-tool/tool.json")).toBe("verified");
  });
  it("a copy of the signed manifest hosted elsewhere is not the listed tool: trust-on-first-use", () => {
    expect(registryEntryFor([listed], "cw-tool", "https://copy.example.net/cw-tool/tool.json")).toBeUndefined();
    expect(trustFor("https://copy.example.net/cw-tool/tool.json")).toBe("self-signed");
    expect(trustFor("https://tools.example.org/other/tool.json")).toBe("self-signed");
  });
  it("needs the name and the URL to match", () => {
    expect(registryEntryFor([listed], "other", "https://tools.example.org/cw-tool/tool.json")).toBeUndefined();
    expect(registryEntryFor([listed], "cw-tool", "not a url")).toBeUndefined();
    expect(registryEntryFor([listed], "cw-tool", "https://TOOLS.example.org/cw-tool/tool.json")).toBe(listed);
  });
  it("resolves a relative entry against the registry's own URL", () => {
    const rel: RegistryEntry = { ...listed, entry: "/tools/cw-tool/tool.json" };
    const reg = "https://app.example.org/tools/registry.json";
    expect(registryEntryFor([rel], "cw-tool", "https://app.example.org/tools/cw-tool/tool.json", reg)).toBe(rel);
    expect(registryEntryFor([rel], "cw-tool", "https://copy.example.net/tools/cw-tool/tool.json", reg)).toBeUndefined();
    expect(registryEntryFor([rel], "cw-tool", "https://app.example.org/tools/cw-tool/tool.json")).toBeUndefined();
  });
});
