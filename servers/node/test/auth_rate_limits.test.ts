// SPDX-License-Identifier: AGPL-3.0-or-later
// Every sign-in endpoint is throttled per client address. Sending mail is throttled per mailbox too, so a
// pool of addresses cannot flood one inbox. The claim probe and the passkey sign-in steps carry no per-call
// budget: requests naming someone's call from many addresses must never keep that person out.
import { describe, it, expect } from "vitest";
import { authEnv, call, newAuthenticator, passkeyLogin, passkeyRegister } from "./helpers/authflow.js";
import type { Env } from "@aprscaching/gateway/env";

type Hit = (env: Env, i: number, ip: string) => Promise<number>;

async function statuses(env: Env, n: number, hit: Hit, ip: (i: number) => string): Promise<number[]> {
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(await hit(env, i, ip(i)));
  return out;
}
const sameIp = () => "198.51.100.1";
const rotatingIp = (i: number) => `203.0.113.${i + 1}`;

const holder = newAuthenticator();
async function withPasskey() {
  const env = authEnv();
  expect((await passkeyRegister(env, "OE8APR", await holder)).status).toBe(200);
  return env;
}

/** [path, setup, a hit from varying identities, a hit naming one identity, is that identity throttled] */
const cases: Array<[string, () => Promise<Env>, Hit, Hit, boolean]> = [
  [
    "/auth/email/start",
    async () => authEnv(),
    async (env, i, ip) =>
      (await call(env, "POST", "/auth/email/start", { email: `u${i}@example.test`, callsign: `DL${i}AA` }, {}, ip))
        .status,
    async (env, _i, ip) =>
      (await call(env, "POST", "/auth/email/start", { email: "one@example.test", callsign: "DL1ONE" }, {}, ip)).status,
    true,
  ],
  [
    "/auth/passkey/login/begin",
    withPasskey,
    async (env, i, ip) =>
      (await call(env, "POST", "/auth/passkey/login/begin", { callsign: `DL${i}AA` }, {}, ip)).status,
    async (env, _i, ip) =>
      (await call(env, "POST", "/auth/passkey/login/begin", { callsign: "OE8APR" }, {}, ip)).status,
    false,
  ],
  [
    "/auth/passkey/login/finish",
    withPasskey,
    async (env, i, ip) =>
      (await call(env, "POST", "/auth/passkey/login/finish", { callsign: `DL${i}AA`, credential: {} }, {}, ip)).status,
    async (env, _i, ip) =>
      (await call(env, "POST", "/auth/passkey/login/finish", { callsign: "OE8APR", credential: {} }, {}, ip)).status,
    false,
  ],
  [
    "/auth/claim",
    async () => authEnv(),
    async (env, i, ip) => (await call(env, "POST", "/auth/claim", { callsign: `DL${i}AA` }, {}, ip)).status,
    async (env, _i, ip) => (await call(env, "POST", "/auth/claim", { callsign: "OE8APR" }, {}, ip)).status,
    false,
  ],
];

describe("auth endpoints are rate limited", () => {
  for (const [path, mk, perIp, perId, idThrottled] of cases) {
    it(`${path}: per client address`, async () => {
      const env = await mk();
      const s = await statuses(env, 60, perIp, sameIp);
      expect(s).toContain(429);
      // another address still gets through
      expect(await perIp(env, 999, "192.0.2.200")).not.toBe(429);
    });

    if (idThrottled)
      it(`${path}: per targeted identity across rotating addresses`, async () => {
        const env = await mk();
        expect(await statuses(env, 60, perId, rotatingIp)).toContain(429);
      });
    else
      it(`${path}: requests naming one call from many addresses are not throttled by that call`, async () => {
        const env = await mk();
        expect(await statuses(env, 60, perId, rotatingIp)).not.toContain(429);
      });
  }

  it("the holder still signs in while other addresses keep beginning sign-ins for the call", async () => {
    const env = await withPasskey();
    for (let i = 0; i < 40; i++)
      await call(env, "POST", "/auth/passkey/login/begin", { callsign: "OE8APR" }, {}, rotatingIp(i));
    expect((await passkeyLogin(env, "OE8APR", await holder, "192.0.2.77")).status).toBe(200);
  });
});
