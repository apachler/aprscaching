// SPDX-License-Identifier: AGPL-3.0-or-later
// Per-instance legal pages: the imprint + privacy notice render the operator's identity from the
// OPERATOR_* env, and show a visible not-configured warning (never silent placeholders) without it.
import { describe, it, expect } from "vitest";
import { handleImprintPage, handlePrivacyPage, handleTermsPage } from "../src/legal.js";
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

  it("privacy states how long moderation records are kept, from MODERATION_RETENTION_DAYS", async () => {
    expect(await handlePrivacyPage(configured).text()).toContain("deleted after\n  730 days");
    const set = await handlePrivacyPage({ ...configured, MODERATION_RETENTION_DAYS: "365" } as Env).text();
    expect(set).toContain("deleted after\n  365 days");
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

  it("imprint shows the editorial line only when one is set", async () => {
    expect(await handleImprintPage(configured).text()).not.toContain("Editorial line");
    const html = await handleImprintPage({
      ...configured,
      EDITORIAL_LINE: "Amateur-radio geocaching <b>news</b>",
    } as Env).text();
    expect(html).toContain("Editorial line: Amateur-radio geocaching &lt;b&gt;news&lt;/b&gt;");
  });

  it("privacy gives each purpose its legal basis and lists every right", async () => {
    const html = await handlePrivacyPage(configured).text();
    for (const basis of ["Art. 6(1)(b)", "Art. 6(1)(a)", "Art. 6(1)(f)"]) expect(html).toContain(basis);
    for (const right of ["Art. 15, 20", "Art. 16", "Art. 17", "Art. 18", "Art. 21", "Art. 7(3)", "Art. 77", "Art. 22"])
      expect(html).toContain(right);
    expect(html).toContain("Musterweg 1, 9020 Klagenfurt, Austria"); // the controller's address, not only the name
  });

  it("privacy names the supervisory authority when set, and the right to complain without it", async () => {
    expect(await handlePrivacyPage(configured).text()).toContain("a data-protection supervisory authority");
    const dsb = "Österreichische Datenschutzbehörde, Barichgasse 40–42, 1030 Wien, dsb@dsb.gv.at";
    expect(await handlePrivacyPage({ ...configured, PRIVACY_AUTHORITY: dsb } as Env).text()).toContain(dsb);
  });

  it("privacy states the retention periods the nightly prune applies, from the settings", async () => {
    const html = await handlePrivacyPage(configured).text();
    expect(html).toContain("positions 7 days");
    expect(html).toContain("raw packets 24 hours");
    expect(html).toContain("expires after 30 days"); // the sign-in cookie, SESSION_TTL_DAYS default
    expect(html).toContain("map entry\n  one year after last heard");
    const set = await handlePrivacyPage({
      ...configured,
      RETENTION: JSON.stringify({ packetsHours: 6, sensorDays: 90 }),
      SESSION_TTL_DAYS: "14",
      MESHCOM_NODE_TTL_DAYS: "3",
    } as Env).text();
    expect(set).toContain("raw packets 6 hours");
    expect(set).toContain("readings\n  90 days");
    expect(set).toContain("expires after 14 days");
    expect(set).toContain("MeshCom nodes 3 days after last heard");
  });

  it("privacy names Cloudflare behind a declared edge and the hosting provider when set", async () => {
    const bare = await handlePrivacyPage(configured).text();
    expect(bare).not.toContain("Cloudflare");
    expect(bare).not.toContain("Hosting provider</strong>");
    const html = await handlePrivacyPage({
      ...configured,
      TRUST_CF: "1",
      HOSTING_PROVIDER: "Oracle Cloud Infrastructure, Frankfurt (Germany)",
    } as Env).text();
    expect(html).toContain("<strong>Cloudflare</strong>");
    expect(html).toContain("Hosting provider</strong> (Oracle Cloud Infrastructure, Frankfurt (Germany))");
  });

  it("privacy marks the Resend API as a third-country transfer, and an SMTP host not", async () => {
    const mail = { ...configured, EMAIL_FROM: "n@example.net" };
    const resend = await handlePrivacyPage({ ...mail, EMAIL_API_KEY: "re_x" } as Env).text();
    expect(resend).toContain("Resend, Inc. in the United States");
    const smtp = await handlePrivacyPage({ ...mail, SMTP_HOST: "mail.example.net" } as Env).text();
    expect(smtp).not.toContain("a third country.</li>");
  });

  it("privacy names the device database host only while DEVICEID_URL is set", async () => {
    expect(await handlePrivacyPage(configured).text()).not.toContain("APRS device database");
    const on = await handlePrivacyPage({
      ...configured,
      DEVICEID_URL: "https://aprs-deviceid.aprsfoundation.org/tocalls.dense.json",
    } as Env).text();
    expect(on).toContain("APRS device database</strong> (aprs-deviceid.aprsfoundation.org)");
  });

  it("terms of use name the operator, the rules and Austrian law, and link the other legal pages", async () => {
    const res = handleTermsPage(configured);
    const html = await res.text();
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(html).toContain("run by <strong>Max Mustermann</strong>");
    expect(html).toContain("non-commercial");
    expect(html).toContain("Fair play");
    expect(html).toContain("Settings → Your data");
    expect(html).toContain("Austrian law");
    expect(html).toContain("Last changed:");
    expect(html).toContain("/play/community/#report-a-problem");
    for (const href of ['href="/imprint"', 'href="/privacy"']) expect(html).toContain(href);
    expect(html).not.toContain("not configured");
    expect(await handleTermsPage(base).text()).toContain("not configured");
  });

  it("every legal page links the terms, and the privacy notice rests Art. 6(1)(b) on them", async () => {
    for (const h of [handleImprintPage, handlePrivacyPage, handleTermsPage])
      expect(await h(configured).text()).toContain('href="/terms"');
    expect(await handlePrivacyPage(configured).text()).toContain(
      'under the <a href="/terms">terms of use</a> (Art. 6(1)(b))',
    );
  });

  it("privacy names the transfer safeguards, and the providers they cover", async () => {
    const bare = await handlePrivacyPage(configured).text();
    expect(bare).toContain("EU-US Data Privacy");
    expect(bare).toContain("(Art. 46(2)(c))");
    expect(bare).not.toContain("tells you on request");
    expect(bare).not.toContain("This applies to");
    const html = await handlePrivacyPage({
      ...configured,
      EMAIL_API_KEY: "re_x",
      EMAIL_FROM: "n@example.net",
      TRUST_CF: "1",
      HOSTING_PROVIDER: "Oracle Cloud Infrastructure (Oracle Corporation), EU region",
    } as Env).text();
    expect(html).toContain("This applies to Resend (United States); Cloudflare (United States); the hosting provider");
    expect(html).toContain("even where it stores the data in an EU region");
  });

  it("privacy states the Art. 14(5)(b) notice and how a station objects", async () => {
    const html = await handlePrivacyPage(configured).text();
    expect(html).toContain("Art. 14(5)(b)");
    expect(html).toContain("object by e-mail to the operator");
  });

  it("privacy states the backups' retention from BACKUP_RETENTION_DAYS", async () => {
    expect(await handlePrivacyPage(configured).text()).toContain("when the oldest copy holding it is deleted");
    const set = await handlePrivacyPage({ ...configured, BACKUP_RETENTION_DAYS: "14" } as Env).text();
    expect(set).toContain("Backups are kept for 14 days, so an erased record leaves them within 14 days.");
    const bad = await handlePrivacyPage({ ...configured, BACKUP_RETENTION_DAYS: "x" } as Env).text();
    expect(bad).toContain("when the oldest copy holding it is deleted");
  });
});
