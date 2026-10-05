// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { validateManifest } from "../src/manifest.js";
import { checkManifestSignature } from "../src/registry.js";
import { signWithToolkey } from "./fixtures/signed.mjs";

describe("a manifest signed with tools/toolkey verifies in the app", () => {
  it("verifies over the file as written, which validation then normalises", async () => {
    const raw = await signWithToolkey({
      name: "hello-tool",
      title: "Hello",
      author: "n0call",
      version: "1.0.0",
      permissions: ["panel"],
      entry: "https://example.net/hello/1.0.0/tool.js",
    });
    expect(validateManifest(raw).ok).toBe(true);
    expect(await checkManifestSignature(raw)).toBe("valid");
    expect(await checkManifestSignature({ ...raw, title: "Changed" })).toBe("invalid");
    expect(await checkManifestSignature({ ...raw, signature: undefined })).toBe("unsigned");
  });
});
