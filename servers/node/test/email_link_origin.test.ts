// SPDX-License-Identifier: AGPL-3.0-or-later
// The email sign-in link points at the gateway that issued it. Where the app and the gateway share a host
// (Caddy, the tunnel, the desktop binary) that is APP_URL; where the app is a static site on another host
// (Cloudflare Pages in front of an API Worker) the app host cannot answer /auth/*, so the link names the
// gateway's own public origin. The confirm step stays the gateway's page: a GET never consumes the token,
// and only a same-origin (or configured app origin) POST does.
import { describe, it, expect } from "vitest";
import { authEnv } from "./helpers/authflow.js";
import { serve } from "./helpers/fedpeer.js";
import type { Env } from "@aprscaching/gateway/env";

const APP = "https://app.test";

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
    const env = authEnv({ APP_URL: APP });
    const s = await start(env, "https://api.test/auth/email/start");
    expect(s.devLink).toBe(`https://api.test/auth/email/verify?token=${s.devToken}`);
  });

  it("names APP_URL when the app and the gateway share a host", async () => {
    const env = authEnv({ APP_URL: APP });
    const s = await start(env, "http://app.test/auth/email/start");
    expect(s.devLink).toBe(`${APP}/auth/email/verify?token=${s.devToken}`);
  });

  it("takes the scheme a TLS-terminating proxy reports, and never downgrades an https request", async () => {
    const env = authEnv({ APP_URL: APP });
    const proxied = await start(env, "http://api.test/auth/email/start", { "x-forwarded-proto": "https" });
    expect(proxied.devLink.startsWith("https://api.test/")).toBe(true);
    const spoofed = await start(env, "https://api.test/auth/email/start", { "x-forwarded-proto": "http" });
    expect(spoofed.devLink.startsWith("https://api.test/")).toBe(true);
  });

  it("opens the gateway's confirm page, which signs in only on a same-origin POST, then returns to the app", async () => {
    const env = authEnv({ APP_URL: APP });
    const s = await start(env, "https://api.test/auth/email/start");
    const page = await serve(env)(new Request(s.devLink, { headers: { accept: "text/html" } }));
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('action="/auth/email/verify"');
    const post = (origin: string) =>
      serve(env)(
        new Request("https://api.test/auth/email/verify", {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded", origin, "x-real-ip": "192.0.2.10" },
          body: new URLSearchParams({ token: s.devToken }).toString(),
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
