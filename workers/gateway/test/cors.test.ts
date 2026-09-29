// SPDX-License-Identifier: AGPL-3.0-or-later
// Reflective CORS must not echo credentials for an arbitrary origin. Credentials are
// allowed only for APP_URL / CORS_ORIGINS; other origins get non-credentialed CORS (enough for the
// public Bearer-keyed read API, not enough to ride a session cookie).
import { describe, it, expect } from "vitest";
import { withCors } from "../src/app.js";
import type { Env } from "../src/env.js";

const reqFrom = (origin?: string) =>
  new Request("http://api.gw/x", origin ? { headers: { Origin: origin } } : undefined);
const cors = (origin: string | undefined, env: Partial<Env>) =>
  withCors(new Response("ok"), reqFrom(origin), env as Env);

describe("CORS credentials are allowlisted", () => {
  it("echoes credentials only for an allowlisted origin", () => {
    const env = { APP_URL: "https://aprscaching.net" };
    const good = cors("https://aprscaching.net", env);
    expect(good.headers.get("Access-Control-Allow-Origin")).toBe("https://aprscaching.net");
    expect(good.headers.get("Access-Control-Allow-Credentials")).toBe("true");

    const evil = cors("https://evil.example", env);
    expect(evil.headers.get("Access-Control-Allow-Origin")).toBe("https://evil.example"); // read API still open
    expect(evil.headers.get("Access-Control-Allow-Credentials")).toBeNull(); // …but no cookie ride
  });

  it("honours extra CORS_ORIGINS entries", () => {
    const env = { APP_URL: "https://aprscaching.net", CORS_ORIGINS: "https://aprscaching.com, https://embed.example" };
    expect(cors("https://embed.example", env).headers.get("Access-Control-Allow-Credentials")).toBe("true");
    expect(cors("https://aprscaching.com", env).headers.get("Access-Control-Allow-Credentials")).toBe("true");
    expect(cors("https://nope.example", env).headers.get("Access-Control-Allow-Credentials")).toBeNull();
  });

  it("an unconfigured instance (no APP_URL, no CORS_ORIGINS) sends no credentialed CORS", () => {
    const anyOrigin = cors("https://anything.example", {});
    expect(anyOrigin.headers.get("Access-Control-Allow-Credentials")).toBeNull();
    // no reflection of the caller's origin either: the public read API stays reachable via `*`,
    // which a browser never pairs with cookies
    expect(anyOrigin.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  it("an unconfigured instance answers a preflight without credentials", () => {
    const res = withCors(
      new Response(null, { status: 204 }),
      new Request("http://api.gw/auth/session", {
        method: "OPTIONS",
        headers: { Origin: "https://evil.example", "Access-Control-Request-Headers": "content-type" },
      }),
      {} as Env,
    );
    expect(res.headers.get("Access-Control-Allow-Credentials")).toBeNull();
    expect(res.headers.get("Access-Control-Allow-Origin")).not.toBe("https://evil.example");
  });

  it("a same-origin (no Origin header) request is untouched", () => {
    const res = cors(undefined, { APP_URL: "https://aprscaching.net" });
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });
});
