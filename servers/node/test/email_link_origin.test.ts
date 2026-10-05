// SPDX-License-Identifier: AGPL-3.0-or-later
// The email sign-in link points at the gateway that issued it, on the address the request came on. Where the
// app and the gateway share a host (Caddy, the tunnel, the desktop binary) that is APP_URL; a gateway on its own
// host beside a static app lists that host in EXTRA_ORIGINS, and the link names it, carrying the app's origin
// for the confirm step to return to. The confirm step stays the gateway's page: a GET never consumes the
// token, and only a same-origin (or configured app origin) POST does.
import { describe, it, expect } from "vitest";
import { authEnv } from "./helpers/authflow.js";
import { serve } from "./helpers/fedpeer.js";
import type { Env } from "@aprscaching/gateway/env";

const APP = "https://app.test";
const SPLIT = { APP_URL: APP, EXTRA_ORIGINS: "https://api.test" };

async function start(env: Env, url: string, headers: Record<string, string> = {}) {
  const res = await serve(env)(
    new Request(url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-real-ip": "192.0.2.10", ...headers },
      body: JSON.stringify({ email: "link@example.test", callsign: "OE8LNK" }),
    }),
  );
  expect(res.status).toBe(200);
  return (await res.json()) as { devToken: string; devLink: string };
}

describe("email sign-in link", () => {
  it("names the gateway's own origin when the app lives on another host", async () => {
    const env = authEnv(SPLIT);
    const s = await start(env, "https://api.test/auth/email/start");
    expect(s.devLink).toBe(`https://api.test/auth/email/verify?token=${s.devToken}`);
    // asked from the app's page, the link carries where the confirm step returns
    const fromApp = await start(env, "https://api.test/auth/email/start", { origin: APP });
    expect(fromApp.devLink).toBe(
      `https://api.test/auth/email/verify?token=${fromApp.devToken}&app=${encodeURIComponent(APP)}`,
    );
  });

  it("names APP_URL for a host nobody listed, so a forged Host never receives a token", async () => {
    const env = authEnv({ APP_URL: APP });
    const s = await start(env, "https://evil.test/auth/email/start", { origin: "https://evil.test" });
    expect(s.devLink).toBe(`${APP}/auth/email/verify?token=${s.devToken}`);
  });

  it("names APP_URL when the app and the gateway share a host", async () => {
    const env = authEnv({ APP_URL: APP });
    const s = await start(env, "http://app.test/auth/email/start");
    expect(s.devLink).toBe(`${APP}/auth/email/verify?token=${s.devToken}`);
  });

  it("takes the scheme a TLS-terminating proxy reports, and never downgrades an https request", async () => {
    const env = authEnv(SPLIT);
    const proxied = await start(env, "http://api.test/auth/email/start", { "x-forwarded-proto": "https" });
    expect(proxied.devLink.startsWith("https://api.test/")).toBe(true);
    const spoofed = await start(env, "https://api.test/auth/email/start", { "x-forwarded-proto": "http" });
    expect(spoofed.devLink.startsWith("https://api.test/")).toBe(true);
  });

  it("opens the gateway's confirm page, which signs in only on a same-origin POST, then returns to the app", async () => {
    const env = authEnv(SPLIT);
    const s = await start(env, "https://api.test/auth/email/start", { origin: APP });
    const page = await serve(env)(new Request(s.devLink, { headers: { accept: "text/html" } }));
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('action="/auth/email/verify"');
    expect(html).toContain(`name="app" value="${APP}"`);
    // an `app` that is no address of the instance never reaches the page
    const forged = await serve(env)(
      new Request(`https://api.test/auth/email/verify?token=${s.devToken}&app=https%3A%2F%2Fevil.test`, {
        headers: { accept: "text/html" },
      }),
    );
    expect(await forged.text()).not.toContain("evil.test");
    const post = (origin: string) =>
      serve(env)(
        new Request("https://api.test/auth/email/verify", {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded", origin, "x-real-ip": "192.0.2.10" },
          body: new URLSearchParams({ token: s.devToken, app: APP }).toString(),
        }),
      );
    // opening the link consumed nothing, and a foreign page cannot confirm it
    expect((await post("https://evil.test")).status).toBe(403);
    const ok = await post("https://api.test");
    expect(ok.status).toBe(303);
    expect(ok.headers.get("location")).toBe(`${APP}/`);
    expect(ok.headers.get("set-cookie")).toMatch(/^acs=/);
    // the token is spent
    expect((await post("https://api.test")).status).toBe(400);
  });
});
