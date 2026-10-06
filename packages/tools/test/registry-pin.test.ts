// SPDX-License-Identifier: MIT
// A registry's key is pinned by a person who compared its fingerprint: the preview shows the key the file names
// and checks only that the file is intact, and a later file signed by another key is refused as key-changed.
import { describe, it, expect } from "vitest";
import {
  authorityFingerprint,
  checkEntryHash,
  checkManifestSignature,
  sha256B64,
  signManifest,
  validateManifest,
  bytesToB64,
  checkPinnedRegistry,
  previewRegistry,
  signRegistry,
  type RegistryEntry,
} from "../src/index.js";

async function genKeys() {
  const kp = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const rawPub = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
  return { priv: kp.privateKey, pub: bytesToB64(rawPub, true) };
}
const entries: RegistryEntry[] = Array.from({ length: 7 }, (_, i) => ({
  name: `tool-${i}`,
  title: `Tool ${i}`,
  author: "OE8APR",
  version: "1.0.0",
  pubkey: "uibFUCjcBnxAe8mRQ1v2neJd0fPV_7Vs0Y59K5vH5Oc",
  entry: `tool-${i}/tool.json`,
}));

describe("authorityFingerprint", () => {
  it("is the first 64 bits of SHA-256 over the raw key, in four groups", async () => {
    const fp = await authorityFingerprint("22usQMnB0VLUKlwA176NK2EZwqcSxcgx0M_rS2jNWp0");
    expect(fp).toMatch(/^[0-9a-f]{4} [0-9a-f]{4} [0-9a-f]{4} [0-9a-f]{4}$/);
    expect(await authorityFingerprint("short")).toBeNull();
  });
});

describe("previewRegistry", () => {
  it("shows the key the file names, its count and a sample of titles", async () => {
    const k = await genKeys();
    const reg = await signRegistry(entries, k.pub, k.priv);
    const r = await previewRegistry(reg);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.preview).toMatchObject({ authority: k.pub, count: 7 });
    expect(r.preview.titles).toEqual(["Tool 0", "Tool 1", "Tool 2", "Tool 3", "Tool 4"]);
    expect(r.preview.fingerprint).toBe(await authorityFingerprint(k.pub));
  });

  it("refuses a file whose signature does not verify under its own key, and a non-registry", async () => {
    const k = await genKeys();
    const reg = await signRegistry(entries, k.pub, k.priv);
    expect((await previewRegistry({ ...reg, entries: entries.slice(1) })).ok).toBe(false);
    expect((await previewRegistry({ hello: 1 })).ok).toBe(false);
    expect((await previewRegistry(null)).ok).toBe(false);
  });
});

describe("checkPinnedRegistry", () => {
  it("accepts the pinned key's file, and calls another key's file key-changed", async () => {
    const a = await genKeys();
    const b = await genKeys();
    const byA = await signRegistry(entries, a.pub, a.priv);
    const byB = await signRegistry(entries, b.pub, b.priv);
    expect(await checkPinnedRegistry(byA, a.pub)).toBe("ok");
    expect(await checkPinnedRegistry(byB, a.pub)).toBe("key-changed");
  });

  it("calls a file that names the pinned key but fails its signature invalid", async () => {
    const a = await genKeys();
    const b = await genKeys();
    const forged = { ...(await signRegistry(entries, b.pub, b.priv)), authority: a.pub };
    expect(await checkPinnedRegistry(forged, a.pub)).toBe("invalid");
    expect(await checkPinnedRegistry({ nope: true }, a.pub)).toBe("invalid");
  });
});

describe("checkEntryHash", () => {
  it("ties the script bytes to the signed manifest", async () => {
    const k = await genKeys();
    const script = new TextEncoder().encode("register({ commands: { hi: () => 'hi' } });");
    const base = validateManifest({
      name: "hash-tool",
      title: "Hash",
      author: "OE8APR",
      version: "1.0.0",
      permissions: ["command"],
      entry: "tool.js",
      entrySha256: await sha256B64(script),
      pubkey: k.pub,
    });
    expect(base.ok).toBe(true);
    if (!base.ok) return;
    const signed = await signManifest(base.manifest, k.priv);
    expect(await checkManifestSignature(signed)).toBe("valid");
    expect(await checkEntryHash(signed, script)).toBe("ok");
    // another script under the same signed manifest fails, and so does a manifest that pins none
    expect(await checkEntryHash(signed, new TextEncoder().encode("register({});"))).toBe("mismatch");
    expect(await checkEntryHash({ ...signed, entrySha256: undefined }, script)).toBe("missing");
    // changing the pinned hash breaks the manifest's signature
    const swapped = { ...signed, entrySha256: await sha256B64(new TextEncoder().encode("x")) };
    expect(await checkManifestSignature(swapped)).toBe("invalid");
  });

  it("is validated as 32 bytes of base64", () => {
    const m = { name: "x-tool", title: "X", author: "OE8APR", version: "1", permissions: [] };
    expect(validateManifest({ ...m, entrySha256: "abc" }).ok).toBe(false);
    expect(validateManifest({ ...m, entrySha256: 42 }).ok).toBe(false);
  });
});
