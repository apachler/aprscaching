// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it, expect } from "vitest";
import { composeDigest, digestSubject, handleNotifyUnsubscribe, unsubscribeUrl } from "../src/notify.js";
import { b64urlToBytes, bytesToB64url } from "../src/util/b64.js";
import type { Env } from "../src/env.js";

const APP = "https://aprscaching.example";

describe("notify — email digest + helpers", () => {
  it("composeDigest lists the alerts, links the instance and the unsubscribe link", () => {
    const one = composeDigest(
      [{ callsign: "OE8APR", kind: "near_cache", detail: "OE8APR heard near AC-0001 — Schlossberg", ts: 1 }],
      APP,
      `${APP}/api/notify/unsubscribe?token=t`,
    );
    expect(one.subject).toBe("APRScaching: OE8APR heard near AC-0001 — Schlossberg");
    expect(one.text).toContain("• OE8APR heard near AC-0001 — Schlossberg");
    expect(one.text).toContain(`${APP}/`);
    expect(one.text).toContain(`${APP}/api/notify/unsubscribe?token=t`);
    expect(one.text).not.toMatch(/STOP/);

    const many = composeDigest(
      [
        { callsign: "A", kind: "heard", ts: 1 },
        { callsign: "B", kind: "near_cache", detail: "B near X", ts: 2 },
      ],
      APP,
    );
    expect(many.subject).toBe("APRScaching: 2 watched stations heard");
    expect(many.text).toContain("• A heard"); // falls back to callsign+kind when no detail
    expect(many.text).toContain("• B near X");
    expect(many.text).toContain("Settings → Notifications");
  });

  it("the subject counts each topic, the largest first", () => {
    expect(
      digestSubject([
        { callsign: "AC-1", kind: "cache_found", ts: 1 },
        { callsign: "AC-2", kind: "cache_found", ts: 2 },
        { callsign: "OE8APR", kind: "heard", ts: 3 },
        { callsign: "AC-3", kind: "adoption_approved", ts: 4 },
      ]),
    ).toBe("APRScaching: 2 finds of your caches, 1 watched station heard, 1 cache adoption update");
    expect(
      digestSubject([
        { callsign: "DL1FND", kind: "cache_dnf", ts: 1 },
        { callsign: "DL1FND", kind: "cache_maintenance", ts: 2 },
      ]),
    ).toBe("APRScaching: 2 reports on your caches");
    expect(digestSubject([{ callsign: "X", kind: "cache_found", detail: "y".repeat(300), ts: 1 }]).length).toBeLessThan(
      120,
    );
  });

  it("base64url round-trips bytes (and is URL-safe, unpadded)", () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 255, 65, 66]);
    const s = bytesToB64url(bytes);
    expect(s).not.toMatch(/[+/=]/);
    expect([...b64urlToBytes(s)]).toEqual([...bytes]);
  });
});

describe("notify — one-click unsubscribe", () => {
  const ACCT = "0b6c1f7e-2f3a-4c55-9a77-1d2e3f405162";
  function env(): { env: Env; updates: unknown[][] } {
    const updates: unknown[][] = [];
    const DB = {
      prepare: (sql: string) => ({
        bind: (...a: unknown[]) => ({
          run: async () => {
            if (sql.startsWith("UPDATE accounts SET notify_digest = 0")) updates.push(a);
            return { meta: { changes: 1 } };
          },
          first: async () => null,
          all: async () => ({ results: [] }),
        }),
      }),
    };
    return { env: { DB, APP_URL: APP, SESSION_SECRET: "s".repeat(40) } as unknown as Env, updates };
  }

  it("signs a link only with a usable session secret", async () => {
    const { env: e } = env();
    expect(await unsubscribeUrl(e, ACCT)).toMatch(/^https:\/\/aprscaching\.example\/api\/notify\/unsubscribe\?token=/);
    expect(await unsubscribeUrl({ ...e, SESSION_SECRET: undefined } as Env, ACCT)).toBeNull();
  });

  it("GET shows a confirm page and changes nothing; POST turns the digest off", async () => {
    const { env: e, updates } = env();
    const link = (await unsubscribeUrl(e, ACCT))!;
    const page = await handleNotifyUnsubscribe(new Request(link, { headers: { accept: "text/html" } }), e);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('method="post"');
    expect(updates).toHaveLength(0);

    // the mail client's one-click POST (RFC 8058)
    const res = await handleNotifyUnsubscribe(
      new Request(link, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "List-Unsubscribe=One-Click",
      }),
      e,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, digest: false });
    expect(updates).toEqual([[ACCT]]);
  });

  it("refuses a token for another account or with a forged signature", async () => {
    const { env: e, updates } = env();
    const link = new URL((await unsubscribeUrl(e, ACCT))!);
    const [, mac] = link.searchParams.get("token")!.split(".");
    const other = new URL(link);
    other.searchParams.set("token", `ffffffff-2f3a-4c55-9a77-1d2e3f405162.${mac}`);
    const res = await handleNotifyUnsubscribe(new Request(other, { method: "POST" }), e);
    expect(res.status).toBe(400);
    const junk = await handleNotifyUnsubscribe(
      new Request(`${APP}/api/notify/unsubscribe?token=%3Cscript%3E`, { headers: { accept: "text/html" } }),
      e,
    );
    expect(junk.status).toBe(400);
    expect(await junk.text()).not.toContain("<script>");
    expect(updates).toHaveLength(0);
  });
});
