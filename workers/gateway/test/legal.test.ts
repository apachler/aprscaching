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

  it("privacy names who receives data, the email provider and push services only when configured", async () => {
    const bare = await handlePrivacyPage(configured).text();
    expect(bare).toContain("Who receives data");
    expect(bare).toContain("tiles.openfreemap.org");
    expect(bare).toContain("OpenTopoMap");
    expect(bare).toContain("tiles.maps.eox.at");
    expect(bare).toContain("APRS-IS");
    expect(bare).toContain("Federation peers");
    expect(bare).not.toContain("Email provider");
    expect(bare).not.toContain("push services");
    expect(bare).toContain("Settings → Your data");

    const full = await handlePrivacyPage({
      ...configured,
      EMAIL_API_KEY: "re_x",
      EMAIL_FROM: "noreply@example.net",
      VAPID_PUBLIC: "pub",
      VAPID_PRIVATE: "priv",
    } as Env).text();
    expect(full).toContain("Email provider</strong> (api.resend.com)");
    expect(full).toContain("Browser push services");

    // SMTP takes precedence: the page names the mail server, not Resend
    const smtp = await handlePrivacyPage({
      ...configured,
      EMAIL_API_KEY: "re_x",
      EMAIL_FROM: "noreply@example.net",
      SMTP_HOST: "mail.example.net",
    } as Env).text();
    expect(smtp).toContain("Email provider</strong> (mail.example.net)");
    expect(smtp).not.toContain("api.resend.com");
  });

  it("privacy names GitHub while the daily update check is on", async () => {
    expect(await handlePrivacyPage(configured).text()).toContain("api.github.com");
    const off = await handlePrivacyPage({ ...configured, UPDATE_CHECK: "0" } as Env).text();
    expect(off).not.toContain("api.github.com");
  });
});
