// SPDX-License-Identifier: AGPL-3.0-or-later
// Every sign-in and verification endpoint is throttled per client address and per targeted identity
// (email or callsign), so neither one address nor a pool of addresses can hammer one account.
import { describe, it, expect } from "vitest";
import { authEnv, call, emailSignup, newAuthenticator, passkeyRegister } from "./helpers/authflow.js";
import type { Env } from "@aprscaching/gateway/env";

type Hit = (env: Env, i: number, ip: string) => Promise<number>;

async function statuses(env: Env, n: number, hit: Hit, ip: (i: number) => string): Promise<number[]> {
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(await hit(env, i, ip(i)));
  return out;
}
const sameIp = () => "198.51.100.1";
const rotatingIp = (i: number) => `203.0.113.${i + 1}`;

async function withPasskey() {
  const env = authEnv();
  expect((await passkeyRegister(env, "OE8APR", await newAuthenticator())).status).toBe(200);
  return env;
}

const cases: Array<[string, () => Promise<Env>, Hit, Hit]> = [
  [
    "/auth/email/start",
    async () => authEnv(),
    async (env, i, ip) =>
      (await call(env, "POST", "/auth/email/start", { email: `u${i}@example.test`, callsign: `DL${i}AA` }, {}, ip))
        .status,
    async (env, _i, ip) =>
      (await call(env, "POST", "/auth/email/start", { email: "one@example.test", callsign: "DL1ONE" }, {}, ip)).status,
  ],
  [
    "/auth/passkey/login/begin",
    withPasskey,
    async (env, i, ip) =>
      (await call(env, "POST", "/auth/passkey/login/begin", { callsign: `DL${i}AA` }, {}, ip)).status,
    async (env, _i, ip) =>
      (await call(env, "POST", "/auth/passkey/login/begin", { callsign: "OE8APR" }, {}, ip)).status,
  ],
  [
    "/auth/passkey/login/finish",
    withPasskey,
    async (env, i, ip) =>
      (await call(env, "POST", "/auth/passkey/login/finish", { callsign: `DL${i}AA`, credential: {} }, {}, ip)).status,
    async (env, _i, ip) =>
      (await call(env, "POST", "/auth/passkey/login/finish", { callsign: "OE8APR", credential: {} }, {}, ip)).status,
  ],
  [
    "/auth/claim",
    async () => authEnv(),
    async (env, i, ip) => (await call(env, "POST", "/auth/claim", { callsign: `DL${i}AA` }, {}, ip)).status,
    async (env, _i, ip) => (await call(env, "POST", "/auth/claim", { callsign: "OE8APR" }, {}, ip)).status,
  ],
];

describe("auth endpoints are rate limited", () => {
  for (const [path, mk, perIp, perId] of cases) {
    it(`${path}: per client address`, async () => {
      const env = await mk();
      const s = await statuses(env, 60, perIp, sameIp);
      expect(s).toContain(429);
      // another address still gets through
      expect(await perIp(env, 999, "192.0.2.200")).not.toBe(429);
    });

    it(`${path}: per targeted identity across rotating addresses`, async () => {
      const env = await mk();
      expect(await statuses(env, 60, perId, rotatingIp)).toContain(429);
    });
  }

  it("/verify/aprs/confirm: per client address and per callsign for session callers", async () => {
    const env = authEnv();
    const me = await emailSignup(env, "owner@example.test", "OE8APR");
    await call(env, "POST", "/verify/aprs/start", { callsign: "OE8APR" }, { cookie: me.cookie });
    const guess = (ip: string) =>
      call(env, "POST", "/verify/aprs/confirm", { callsign: "OE8APR", code: "000000" }, { cookie: me.cookie }, ip);
    const byIp: number[] = [];
    for (let i = 0; i < 40; i++) byIp.push((await guess("198.51.100.7")).status);
    expect(byIp.filter((s) => s === 429).length).toBeGreaterThan(0);
    const rotating: number[] = [];
    for (let i = 0; i < 40; i++) rotating.push((await guess(`203.0.113.${i + 1}`)).status);
    expect(rotating).toContain(429);
    // the limiter answers before the lookup: its body says "rate limited"
    expect((await guess("203.0.113.250")).data.error).toMatch(/rate limited/);
  });
});
