// SPDX-License-Identifier: AGPL-3.0-or-later
// One instance on several addresses (EXTRA_ORIGINS): each request is answered for the address it came on — its
// session cookie, its sign-in links and the links into the app — when that address is configured, and as APP_URL
// otherwise. Passkeys keep one relying party; every https address is one of its related origins.
import { describe, it, expect } from "vitest";
import { authEnv, newAuthenticator, passkeyRegister } from "./helpers/authflow.js";
import { serve } from "./helpers/fedpeer.js";
import type { Env } from "@aprscaching/gateway/env";

const MAIN = "https://gw.test";
const NET44 = "https://aprscaching.oe8apr.ampr.org";
const HAMNET = "http://aprscaching.oe8xyz.hamnet.example";
const HAMNET_IP = "http://44.143.1.2";

const multi = (extra: Record<string, unknown> = {}) =>
  authEnv({ EXTRA_ORIGINS: `${NET44}, ${HAMNET},${HAMNET_IP}`, ...extra });

/** Email sign-up started and confirmed on `origin`: the start's link, and the confirm's cookie and redirect. */
async function signUpOn(env: Env, origin: string, callsign: string, headers: Record<string, string> = {}) {
  const post = (path: string, body: BodyInit, type: string, extra: Record<string, string> = {}) =>
    serve(env)(
      new Request(`${origin}${path}`, {
        method: "POST",
        headers: { "content-type": type, "x-real-ip": "192.0.2.20", ...headers, ...extra },
        body,
      }),
    );
  const start = await post(
    "/auth/email/start",
    JSON.stringify({ email: `${callsign.toLowerCase()}@example.test`, callsign }),
    "application/json",
  );
  expect(start.status).toBe(200);
  const s = (await start.json()) as { devToken: string; devLink: string };
  const link = new URL(s.devLink);
  const form = new URLSearchParams({ token: s.devToken });
  const app = link.searchParams.get("app");
  if (app) form.set("app", app);
  const confirm = await serve(env)(
    new Request(`${link.origin}/auth/email/verify`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: link.origin,
        "x-real-ip": "192.0.2.20",
        ...headers,
      },
      body: form.toString(),
    }),
  );
  return {
    link: s.devLink,
    status: confirm.status,
    cookie: confirm.headers.get("set-cookie") ?? "",
    back: confirm.headers.get("location"),
  };
}

describe("one instance, several addresses", () => {
  it("signs in over plain http on a HAMNET name: the link stays there, the cookie has no Secure flag", async () => {
    const r = await signUpOn(multi(), HAMNET, "OE8HAM");
    expect(r.link.startsWith(`${HAMNET}/auth/email/verify?token=`)).toBe(true);
    expect(r.status).toBe(303);
    expect(r.back).toBe(`${HAMNET}/`);
    expect(r.cookie).toMatch(/^acs=/);
    expect(r.cookie).not.toMatch(/Secure/);
    expect(r.cookie).not.toMatch(/Domain=/i); // host-only: each address holds its own session
  });

  it("accepts a bare HAMNET IP address as an address of the instance", async () => {
    const r = await signUpOn(multi(), HAMNET_IP, "OE8HIP");
    expect(r.link.startsWith(`${HAMNET_IP}/auth/email/verify?token=`)).toBe(true);
    expect(r.cookie).not.toMatch(/Secure/);
  });

  it("keeps the Secure flag on the https 44Net name and on APP_URL", async () => {
    // Caddy terminates TLS and reports the scheme; the gateway itself sees plain http
    const net44 = await signUpOn(multi(), NET44.replace("https:", "http:"), "OE8NET", { "x-forwarded-proto": "https" });
    expect(net44.link.startsWith(`${NET44}/auth/email/verify?token=`)).toBe(true);
    expect(net44.cookie).toMatch(/; Secure;/);
    const main = await signUpOn(multi(), MAIN, "OE8MAN");
    expect(main.link.startsWith(`${MAIN}/auth/email/verify?token=`)).toBe(true);
    expect(main.cookie).toMatch(/; Secure;/);
  });

  it("answers a host nobody configured as APP_URL: a forged Host never reaches a link or drops Secure", async () => {
    const r = await signUpOn(multi(), "http://evil.test", "OE8EVL");
    expect(r.link.startsWith(`${MAIN}/auth/email/verify?token=`)).toBe(true);
    expect(r.link).not.toContain("evil.test");
  });

  it("an http address listed only as https is not trusted over http", async () => {
    // the 44Net name is listed with https; a plain-http request on it is no listed address
    const r = await signUpOn(multi(), NET44.replace("https:", "http:"), "OE8DWN");
    expect(r.link.startsWith(`${MAIN}/`)).toBe(true);
    expect(r.cookie).toMatch(/; Secure;/);
  });

  it("allows credentialed CORS from every address, never from another origin", async () => {
    const env = multi();
    const preflight = (origin: string) =>
      serve(env)(new Request(`${MAIN}/auth/session`, { method: "OPTIONS", headers: { origin } }));
    for (const o of [MAIN, NET44, HAMNET, HAMNET_IP])
      expect((await preflight(o)).headers.get("access-control-allow-credentials"), o).toBe("true");
    expect((await preflight("https://evil.test")).headers.get("access-control-allow-credentials")).toBeNull();
  });

  it("lists the https addresses as WebAuthn related origins, and no plain-http one", async () => {
    const res = await serve(multi())(new Request(`${MAIN}/.well-known/webauthn`));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/application\/json/);
    expect(await res.json()).toEqual({ origins: [MAIN, NET44] });
  });

  it("verifies a passkey made on a related origin under the main RP_ID, and refuses an unlisted or plain-http one", async () => {
    const env = multi();
    const onNet44 = await passkeyRegister(env, "OE8PKA", await newAuthenticator(), {}, NET44);
    expect(onNet44.status).toBe(200);
    const onHamnet = await passkeyRegister(env, "OE8PKB", await newAuthenticator(), {}, HAMNET);
    expect(onHamnet.status).toBe(400);
    expect(onHamnet.data.error).toMatch(/origin mismatch/);
    const elsewhere = await passkeyRegister(env, "OE8PKC", await newAuthenticator(), {}, "https://evil.test");
    expect(elsewhere.status).toBe(400);
  });
});

// Every combination of the three networks, with each of its addresses in turn as APP_URL: the internet name and
// the 44Net name over https, the HAMNET name over plain http.
const NETWORKS = {
  internet: "https://aprs.example.net",
  "44net": NET44,
  hamnet: HAMNET,
} as const;
type Net = keyof typeof NETWORKS;
const NETS = Object.keys(NETWORKS) as Net[];
const COMBOS: { main: Net; extra: Net[] }[] = [];
for (let mask = 1; mask < 8; mask++) {
  const set = NETS.filter((_, i) => mask & (1 << i));
  for (const main of set) COMBOS.push({ main, extra: set.filter((n) => n !== main) });
}

/** A request on `origin` as Caddy hands it to the gateway: plain http, with the scheme it terminated. */
const viaCaddy = (origin: string) =>
  origin.startsWith("https://")
    ? { url: origin.replace("https://", "http://"), headers: { "x-forwarded-proto": "https" } }
    : { url: origin, headers: { "x-forwarded-proto": "http" } };

describe("every combination of internet, 44Net and HAMNET, each address as APP_URL", () => {
  let n = 0;
  for (const { main, extra } of COMBOS) {
    const label = `APP_URL on ${main}${extra.length ? `, also ${extra.join(" + ")}` : " alone"}`;
    it(label, async () => {
      const addresses = [main, ...extra].map((k) => NETWORKS[k]);
      const env = authEnv({
        APP_URL: NETWORKS[main],
        RP_ID: "",
        INSTANCE: "",
        EXTRA_ORIGINS: extra.map((k) => NETWORKS[k]).join(","),
      });
      const secure = addresses.filter((a) => a.startsWith("https://"));

      // sign-in by email on every address: the link, the cookie and the way back stay on that address
      for (const address of addresses) {
        const call = `OE8${String.fromCharCode(65 + (n % 26))}${String.fromCharCode(65 + Math.floor(n / 26))}`;
        n++;
        const via = viaCaddy(address);
        const r = await signUpOn(env, via.url, call, via.headers);
        expect(r.link.startsWith(`${address}/auth/email/verify?token=`), `${label}: link on ${address}`).toBe(true);
        expect(r.status).toBe(303);
        expect(r.back).toBe(`${address}/`);
        expect(/; Secure;/.test(r.cookie), `${label}: Secure on ${address}`).toBe(address.startsWith("https://"));
      }

      // a host nobody listed is answered as APP_URL
      const forged = await signUpOn(env, "http://evil.test", `OE8Z${String.fromCharCode(65 + (n++ % 26))}`);
      expect(forged.link.startsWith(`${NETWORKS[main]}/`)).toBe(true);

      // the related origins are the https addresses, APP_URL first
      const wk = await serve(env)(new Request(`${NETWORKS[main]}/.well-known/webauthn`));
      expect(await wk.json()).toEqual({ origins: secure });

      // passkeys: on every https address under one relying party, the main one when it is https; none over http
      if (!secure.length) {
        const begin = await serve(env)(
          new Request(`${NETWORKS[main]}/auth/passkey/register/begin`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-real-ip": "192.0.2.30" },
            body: JSON.stringify({ callsign: "OE8NOP" }),
          }),
        );
        expect(begin.status).toBe(503);
        return;
      }
      const rp = new URL(secure[0]!).hostname;
      for (const [i, address] of addresses.entries()) {
        const r = await passkeyRegister(env, `OE8PK${i}`, await newAuthenticator(), {}, address);
        if (address.startsWith("https://")) {
          expect(r.status, `${label}: passkey on ${address}`).toBe(200);
        } else {
          expect(r.status, `${label}: no passkey on ${address}`).toBe(400);
        }
      }
      const begin = await serve(env)(
        new Request(`${NETWORKS[main]}/auth/passkey/register/begin`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-real-ip": "192.0.2.31" },
          body: JSON.stringify({ callsign: "OE8RPX" }),
        }),
      );
      expect(((await begin.json()) as { rp: { id: string } }).rp.id).toBe(rp);
    });
  }
});
