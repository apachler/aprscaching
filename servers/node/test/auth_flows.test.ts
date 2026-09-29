// SPDX-License-Identifier: AGPL-3.0-or-later
// Flows that ride on the account-bound session: transmitting under an SSID of a verified base call, the
// email link that needs an explicit confirm before it signs anyone in, and pairing a remote box by a
// code only that box can obtain.
import { describe, it, expect } from "vitest";
import { authEnv, call, emailSignup, operatorVerify, ORIGIN } from "./helpers/authflow.js";
import { serve } from "./helpers/fedpeer.js";

const INGEST = { "x-ingest-secret": "test-ingest-secret" };

describe("user TX checks the account's hold on the BASE call", () => {
  it("a session on OE8APR-7 transmits when OE8APR is verified", async () => {
    const env = authEnv({ ADMIN_CALLSIGNS: "OE8APR" });
    const s = await emailSignup(env, "tx@example.test", "OE8APR-7");
    expect(s.status).toBe(200);
    await operatorVerify(env, "OE8APR");
    const r = await call(
      env,
      "POST",
      "/api/tx/aprs",
      { kind: "message", addressee: "OE1XYZ", text: "hi" },
      {
        cookie: s.cookie,
      },
    );
    expect(r.status).toBe(201);
    expect(r.data.srcCall).toBe("OE8APR-7");
  });

  it("an unverified base call cannot transmit", async () => {
    const env = authEnv();
    const s = await emailSignup(env, "tx2@example.test", "DL1TXU-7");
    const r = await call(
      env,
      "POST",
      "/api/tx/aprs",
      { kind: "message", addressee: "OE1XYZ", text: "hi" },
      {
        cookie: s.cookie,
      },
    );
    expect(r.status).toBe(403);
    expect(r.data.error).toMatch(/verify DL1TXU/);
  });
});

describe("the email link needs a confirm step", () => {
  const start = async (env: ReturnType<typeof authEnv>, email: string, callsign: string) =>
    (await call(env, "POST", "/auth/email/start", { email, callsign })).data.devToken as string;

  it("GET renders a confirm page and does not consume the token", async () => {
    const env = authEnv();
    const token = await start(env, "csrf@example.test", "DL1CSR");
    const page = await serve(env)(
      new Request(`${ORIGIN}/auth/email/verify?token=${token}`, { headers: { accept: "text/html" } }),
    );
    expect(page.status).toBe(200);
    expect(page.headers.get("set-cookie")).toBeNull();
    const html = await page.text();
    expect(html).toContain('method="post"');
    expect(html).toContain(token);
    const json = await call(env, "GET", `/auth/email/verify?token=${token}`);
    expect(json.cookie).toBe("");
    const row = await env.DB.prepare("SELECT used FROM email_tokens WHERE token=?")
      .bind(token)
      .first<{ used: number }>();
    expect(row?.used).toBe(0);
    // no account exists until the confirm
    expect(await env.DB.prepare("SELECT 1 FROM accounts WHERE callsign='DL1CSR'").first()).toBeNull();
  });

  it("the confirm page never reflects a value that is not a sign-in token", async () => {
    const env = authEnv();
    const probe = encodeURIComponent('"><script>alert(1)</script>');
    const page = await serve(env)(
      new Request(`${ORIGIN}/auth/email/verify?token=${probe}`, { headers: { accept: "text/html" } }),
    );
    expect(page.status).toBe(400);
    expect(page.headers.get("content-type") ?? "").not.toContain("text/html");
    expect(await page.text()).not.toContain("<script>");
  });

  it("POST with the same token signs in (JSON and the confirm form)", async () => {
    const env = authEnv();
    const t1 = await start(env, "form@example.test", "DL1FRM");
    const form = await serve(env)(
      new Request(`${ORIGIN}/auth/email/verify`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", origin: ORIGIN },
        body: `token=${t1}`,
      }),
    );
    expect(form.status).toBe(303);
    expect(form.headers.get("set-cookie")).toMatch(/^acs=/);
    // the token is spent
    expect((await call(env, "POST", "/auth/email/verify", { token: t1 })).status).toBe(400);
  });

  it("the confirm page keeps its own origin on the form POST while keeping the token off other sites", async () => {
    // Under a no-referrer policy a browser sends `Origin: null` with the form POST, which the origin check
    // refuses, so the button would never sign anyone in. `same-origin` sends the page's real origin to the
    // gateway itself and no Referer (so no token) to any other site.
    const env = authEnv();
    const token = await start(env, "policy@example.test", "DL1POL");
    const page = await serve(env)(
      new Request(`${ORIGIN}/auth/email/verify?token=${token}`, { headers: { accept: "text/html" } }),
    );
    expect(page.headers.get("referrer-policy")).toBe("same-origin");
    const html = await page.text();
    expect(html).toContain("<meta name=referrer content=same-origin>");
    expect(html).not.toContain("no-referrer");
    const nullOrigin = await serve(env)(
      new Request(`${ORIGIN}/auth/email/verify`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", origin: "null" },
        body: `token=${token}`,
      }),
    );
    expect(nullOrigin.status).toBe(403);
  });

  it("a cross-site POST of someone else's token is refused (login CSRF)", async () => {
    const env = authEnv();
    const token = await start(env, "attacker@example.test", "DL1ATK");
    const res = await serve(env)(
      new Request(`${ORIGIN}/auth/email/verify`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://evil.example" },
        body: `token=${token}`,
      }),
    );
    expect(res.status).toBe(403);
    expect(res.headers.get("set-cookie")).toBeNull();
  });
});

describe("a remote box is paired by a code only the box can obtain", () => {
  it("a session cannot squat an unpaired box by touching it first", async () => {
    const env = authEnv();
    const s = await emailSignup(env, "squat@example.test", "DL1SQT");
    const r = await call(env, "POST", "/api/box/pi-home/command", { kind: "status" }, { cookie: s.cookie });
    expect(r.status).toBe(403);
    expect(r.data.error).toMatch(/pair/i);
    expect(await env.DB.prepare("SELECT 1 FROM boxes WHERE box_id='pi-home'").first()).toBeNull();
  });

  it("the box mints a code with its secret; the owner claims with it; others cannot", async () => {
    const env = authEnv();
    const owner = await emailSignup(env, "owner@example.test", "DL1OWN");
    const other = await emailSignup(env, "other@example.test", "DL1OTH");
    // a session cannot mint a code — only the box (ingest secret) can
    expect((await call(env, "POST", "/api/box/pi-home/pair", {}, { cookie: owner.cookie })).status).toBe(401);
    const minted = await call(env, "POST", "/api/box/pi-home/pair", {}, INGEST);
    expect(minted.status).toBe(200);
    const code = minted.data.code as string;
    expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    // a wrong code does not claim
    const bad = await call(env, "POST", "/api/box/pi-home/claim", { code: "AAAA-AAAA" }, { cookie: other.cookie });
    expect(bad.status).toBe(403);
    const good = await call(env, "POST", "/api/box/pi-home/claim", { code }, { cookie: owner.cookie });
    expect(good.status).toBe(200);
    // the code is single-use
    expect((await call(env, "POST", "/api/box/pi-home/claim", { code }, { cookie: other.cookie })).status).toBe(403);
    expect(
      (await call(env, "POST", "/api/box/pi-home/command", { kind: "status" }, { cookie: owner.cookie })).status,
    ).toBe(201);
    expect(
      (await call(env, "POST", "/api/box/pi-home/command", { kind: "status" }, { cookie: other.cookie })).status,
    ).toBe(403);
    expect((await call(env, "GET", "/api/box/pi-home/log", undefined, { cookie: other.cookie })).status).toBe(403);
  });

  it("an expired code does not claim", async () => {
    const env = authEnv();
    const s = await emailSignup(env, "late@example.test", "DL1LAT");
    const code = (await call(env, "POST", "/api/box/pi-late/pair", {}, INGEST)).data.code as string;
    await env.DB.prepare("UPDATE box_pairings SET expires_at = 1 WHERE box_id='pi-late'").run();
    expect((await call(env, "POST", "/api/box/pi-late/claim", { code }, { cookie: s.cookie })).status).toBe(403);
  });
});
