// SPDX-License-Identifier: AGPL-3.0-or-later
// /.well-known/security.txt names the instance's own security contact (RFC 9116), and the web-push contact
// names the instance's own operator or host.
import { describe, it, expect } from "vitest";
import { handleSecurityTxt, securityTxt } from "../src/securitytxt.js";
import { vapidSubject } from "../src/notify.js";
import type { Env } from "../src/env.js";

const env = (v: Record<string, string>) => v as unknown as Env;
const NOW = Date.UTC(2026, 9, 4, 12, 0, 0);

describe("security.txt", () => {
  it("names SECURITY_CONTACT, a year's expiry, the policy and the languages", () => {
    const body = securityTxt(
      env({ SECURITY_CONTACT: "mailto:security@example.net, https://example.net/report", OPERATOR_EMAIL: "op@x.test" }),
      NOW,
    );
    expect(body).toBe(
      [
        "Contact: mailto:security@example.net",
        "Contact: https://example.net/report",
        "Expires: 2027-10-04T12:00:00Z",
        "Policy: https://github.com/apachler/aprscaching/blob/main/SECURITY.md",
        "Preferred-Languages: en, de",
        "",
      ].join("\n"),
    );
  });

  it("falls back to the operator's address, and follows a fork's published source", () => {
    const body = securityTxt(
      env({ OPERATOR_EMAIL: "op@example.net", SOURCE_REPO: "https://github.com/someone/fork.git" }),
      NOW,
    );
    expect(body).toContain("Contact: mailto:op@example.net\n");
    expect(body).toContain("Policy: https://github.com/someone/fork/blob/main/SECURITY.md\n");
    const elsewhere = securityTxt(env({ OPERATOR_EMAIL: "op@x.test", SOURCE_REPO: "https://git.example.net/r" }), NOW);
    expect(elsewhere).not.toContain("Policy:");
  });

  it("drops control characters so a value cannot add a field", () => {
    const body = securityTxt(env({ SECURITY_CONTACT: "sec@example.net\nPolicy: https://evil.test" }), NOW)!;
    expect(body.split("\n")[0]).toBe("Contact: mailto:sec@example.netPolicy: https://evil.test");
    expect(body.match(/^Policy:/gm)).toHaveLength(1);
  });

  it("is a 404 without any contact", async () => {
    expect(handleSecurityTxt(env({})).status).toBe(404);
    const ok = handleSecurityTxt(env({ OPERATOR_EMAIL: "op@example.net" }));
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    const expires = /^Expires: (.+)$/m.exec(await ok.text())![1]!;
    expect(Date.parse(expires) - Date.now()).toBeGreaterThan(360 * 24 * 3600 * 1000);
  });
});

describe("VAPID subject", () => {
  it("is VAPID_SUBJECT, else the operator's address, else the instance's https origin", () => {
    expect(vapidSubject(env({ VAPID_SUBJECT: "mailto:push@example.net", OPERATOR_EMAIL: "op@example.net" }))).toBe(
      "mailto:push@example.net",
    );
    expect(vapidSubject(env({ OPERATOR_EMAIL: "op@example.net", APP_URL: "https://oe.example.net" }))).toBe(
      "mailto:op@example.net",
    );
    expect(vapidSubject(env({ APP_URL: "https://oe.example.net/app" }))).toBe("https://oe.example.net");
    expect(vapidSubject(env({ INSTANCE: "oe.example.net" }))).toBe("https://oe.example.net");
    expect(vapidSubject(env({}))).toBeNull();
  });
});
