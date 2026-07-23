// SPDX-License-Identifier: AGPL-3.0-or-later
// Per-instance legal pages: the imprint + privacy notice render the operator's identity from the
// OPERATOR_* env, and show a visible not-configured warning (never silent placeholders) without it.
import { describe, it, expect } from "vitest";
import { handleImprintPage, handlePrivacyPage } from "../src/legal.js";
import type { Env } from "../src/env.js";

const base = { INSTANCE: "test.instance" } as Env;
const configured = {
  ...base,
  OPERATOR_NAME: "Max Mustermann",
  OPERATOR_ADDRESS: "Musterweg 1, 9020 Klagenfurt, Austria",
  OPERATOR_EMAIL: "op@example.net",
} as Env;

describe("legal pages", () => {
  it("imprint renders the configured operator identity", async () => {
    const res = handleImprintPage(configured);
    const html = await res.text();
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(html).toContain("Max Mustermann");
    expect(html).toContain("Musterweg 1");
    expect(html).toContain("op@example.net");
    expect(html).not.toContain("not configured");
  });

  it("imprint warns loudly when the operator has not configured it", async () => {
    const html = await handleImprintPage(base).text();
    expect(html).toContain("OPERATOR_NAME");
    expect(html).toContain("not configured");
  });

  it("privacy names the controller when configured and links the GDPR tools", async () => {
    const html = await handlePrivacyPage(configured).text();
    expect(html).toContain("Max Mustermann");
    expect(html).toContain("GDPR");
    expect(html).toContain("tombstones"); // erasure propagation is stated, not implied
  });

  it("privacy escapes operator-supplied values (no HTML injection)", async () => {
    const evil = { ...base, OPERATOR_NAME: "<script>x</script>", OPERATOR_EMAIL: "a@b.c" } as Env;
    const html = await handlePrivacyPage(evil).text();
    expect(html).not.toContain("<script>x</script>");
    expect(html).toContain("&lt;script&gt;");
  });
});
