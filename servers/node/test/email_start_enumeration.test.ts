// SPDX-License-Identifier: AGPL-3.0-or-later
// The magic-link start answers every well-formed request the same way, so nobody learns from it whether an
// address has an account. What the address may do goes to the mailbox: the link, or why there is none.
import { describe, it, expect, vi, afterEach } from "vitest";
import { authEnv, call, emailSignup } from "./helpers/authflow.js";

afterEach(() => vi.unstubAllGlobals());

/** Mail configured over the Resend API, its sends captured. */
function withMail(env: ReturnType<typeof authEnv>) {
  const sent: { to: string; subject: string; text: string }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_u: string, init: RequestInit) => {
      sent.push(JSON.parse(String(init.body)) as { to: string; subject: string; text: string });
      return new Response("{}", { status: 200 });
    }),
  );
  Object.assign(env, { EMAIL_API_KEY: "k", EMAIL_FROM: "gw@example.test", ALLOW_DEV_TOKENS: "0" });
  return sent;
}

describe("POST /auth/email/start tells nobody whether an address has an account", () => {
  it("answers alike for an account, no account, a held call and the data link, and mails the reason", async () => {
    const env = authEnv();
    expect((await emailSignup(env, "member@example.test", "OE1MEM")).status).toBe(200);
    const sent = withMail(env);
    const cases: [string, Record<string, unknown>][] = [
      ["member@example.test", { callsign: "OE1MEM" }], // sign-in link
      ["nobody@example.test", { callsign: "OE1NEW" }], // register link
      ["nobody2@example.test", {}], // no account, no callsign
      ["nobody3@example.test", { callsign: "OE1MEM" }], // no account, a call someone holds
      ["nobody4@example.test", { purpose: "account-data" }], // no account for a data link
      ["member@example.test", { purpose: "account-data" }], // an account that holds a call
    ];
    const answers = [];
    for (const [email, rest] of cases) {
      const r = await call(env, "POST", "/auth/email/start", { email, ...rest });
      answers.push({ status: r.status, data: r.data });
    }
    for (const a of answers) expect(a).toEqual({ status: 200, data: { sent: true } });
    expect(sent.map((m) => m.to)).toEqual(cases.map(([e]) => e));
    expect(sent[0]!.text).toMatch(/\/auth\/email\/verify\?token=/);
    expect(sent[1]!.text).toMatch(/\/auth\/email\/verify\?token=/);
    expect(sent[2]!.text).toMatch(/No APRScaching account uses this address.*give your callsign/s);
    expect(sent[3]!.text).toMatch(/OE1MEM cannot open a new one: .*sign in/);
    expect(sent[4]!.text).toMatch(/No APRScaching account uses this address/);
    expect(sent[5]!.text).toMatch(/holds a callsign/);
    for (const m of sent.slice(2)) expect(m.text).not.toMatch(/token=/);
  });

  it("answers 503 alike when the mail cannot go out", async () => {
    const env = authEnv();
    expect((await emailSignup(env, "member@example.test", "OE1MEM")).status).toBe(200);
    Object.assign(env, { ALLOW_DEV_TOKENS: "0" });
    const a = await call(env, "POST", "/auth/email/start", { email: "member@example.test" });
    const b = await call(env, "POST", "/auth/email/start", { email: "nobody@example.test" });
    expect(a.status).toBe(503);
    expect(b).toEqual(a);
  });
});
