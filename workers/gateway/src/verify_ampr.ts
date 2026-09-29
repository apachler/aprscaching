// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * verify_ampr.ts — callsign control-verification through ampr.org DNS (`ampr_dns`).
 *
 * ARDC delegates `<call>.ampr.org` to a ham only after reviewing their licence, and only that holder can
 * publish names under it at the ARDC portal. So a code the holder publishes as
 *
 *   _aprscaching.<call>.ampr.org  TXT  "v=acs1; verify=<code>"
 *
 * proves control of the call — provided the answer is authentic. The gateway therefore verifies only a
 * DNSSEC-validated answer (the resolver's AD flag): anything else could have been forged in transit, and
 * a user's verification never trusts on first use. The name must exist under ampr.org, and the TXT must
 * carry the current code of a challenge this account started for the call. The record shares its name
 * with the federation binding (fed44net.ts); both are `v=acs1` TXT records and may coexist.
 */
import type { Env } from "./env.js";
import { json } from "./app.js";
import { markVerified } from "./callsign.js";
import { resolveTxt, acsFields, amprNames, NXDOMAIN, type TxtAnswer } from "./doh.js";
import {
  holderOf,
  issueChallenge,
  openChallenge,
  completionLimited,
  failAttempt,
  spendChallenge,
  randomToken,
  noChallenge,
  startsLimited,
} from "./verify_challenge.js";

/** Publishing a record at the ARDC portal and waiting out TTLs takes time: a code is good for 48 hours. */
export const AMPR_CHALLENGE_TTL_SEC = 48 * 3600;

/** The TXT value that completes a challenge. */
export const amprTxtValue = (code: string) => `v=acs1; verify=${code}`;

/** POST /verify/ampr/start {callsign} — issue a code and name the exact record to publish. */
export async function startAmprChallenge(req: Request, env: Env): Promise<Response> {
  const c = await holderOf(req, env);
  if (c instanceof Response) return c;
  const code = randomToken(16);
  const issued = await issueChallenge(env, c, "ampr_dns", code);
  if (!issued) return startsLimited();
  const { name } = amprNames(c.cs);
  const value = amprTxtValue(code);
  return json({
    code,
    name,
    type: "TXT",
    value,
    record: `${name} TXT "${value}"`,
    expiresAt: issued.createdAt + AMPR_CHALLENGE_TTL_SEC,
  });
}

/** POST /verify/ampr/check {callsign} — look the record up and verify the call when it checks out. */
export async function checkAmprChallenge(req: Request, env: Env): Promise<Response> {
  const c = await holderOf(req, env);
  if (c instanceof Response) return c;
  if (await completionLimited(env, c, "ampr_dns")) return startsLimited();
  const code = await openChallenge(env, c, "ampr_dns", AMPR_CHALLENGE_TTL_SEC);
  if (!code) return noChallenge();
  const { host, name } = amprNames(c.cs);
  let ans: TxtAnswer;
  try {
    ans = await resolveTxt(env, name);
  } catch (e) {
    return json({ error: `the DNS lookup failed (${(e as Error).message}) — try again later` }, { status: 502 });
  }
  const refuse = async (error: string) => {
    await failAttempt(env, c, "ampr_dns", code);
    return json({ error, name }, { status: 422 });
  };
  if (ans.status === NXDOMAIN)
    return refuse(`${name} does not exist — publish the TXT record at the ARDC portal, then check again`);
  if (ans.status !== 0) return refuse(`the lookup of ${name} failed (DNS status ${ans.status})`);
  if (!ans.dnssec)
    return refuse(
      `the answer for ${name} is not DNSSEC-validated, so it cannot prove control of ${c.cs} — ampr.org must be DNSSEC-signed and the resolver must validate it; use another verification method`,
    );
  const carries = ans.txts.some((t) => acsFields(t)?.get("verify") === code);
  if (!carries) return refuse(`${name} does not carry the current code — publish "${amprTxtValue(code)}"`);
  if (!(await spendChallenge(env, c, "ampr_dns", code))) return noChallenge();
  await markVerified(env, c.cs, "ampr_dns", { by: host, note: name });
  return json({ verified: true, callsign: c.cs, method: "ampr_dns" });
}
