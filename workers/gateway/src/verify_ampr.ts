// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * verify_ampr.ts — callsign control-verification through ampr.org DNS (`ampr_dns`).
 *
 * ARDC delegates `<call>.ampr.org` to a ham only after reviewing their licence, and only that holder can
 * publish names under it at the ARDC portal. So a code the holder publishes as
 *
 *   _aprscaching-verify.<call>.ampr.org  TXT  "v=acs1; verify=<code>"
 *
 * proves control of the call — provided the answer is authentic. Two proofs count:
 *
 * - **DNSSEC** — the validating resolver (`DOH_URL`) sets AD: the answer is signed from the root down,
 *   and that single answer settles it. This applies by itself as soon as ampr.org is signed.
 * - **Independent resolvers agree** — without AD, every resolver of `AMPR_DNS_RESOLVERS` (default
 *   Cloudflare, Google, Quad9) is asked. At least two must answer, and every one that answers must
 *   return NOERROR with the same TXT set carrying the code. Forging that means poisoning several large,
 *   separately operated caches at once. A resolver that times out or fails at the HTTP level has not
 *   answered and contradicts nothing; a DNS error or a different TXT set from any of them refuses.
 *   `AMPR_REQUIRE_DNSSEC=1` turns this proof off.
 *
 * Either way the answer must be owned by the exact name: an answer through a CNAME or DNAME is refused,
 * because it would take the proof out of the ARDC zone to wherever the alias points. Which proof held is
 * stored in the verification's note (`dnssec`, or `<n> resolvers: <hosts>`), so an operator can find and
 * re-check the weaker ones. The record has a name of its own, apart from the federation identity record
 * (`_aprscaching.<call>.ampr.org`, fed44net.ts): a member proving their call never touches the record peers
 * read, and the code at one name is never mistaken for the binding at the other.
 */
import type { Env } from "./env.js";
import { json } from "./http.js";
import { recordProof } from "./callsign.js";
import { resolveTxt, resolveTxtAt, amprResolvers, acsFields, amprNames, NXDOMAIN, type TxtAnswer } from "./doh.js";
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
const AMPR_CHALLENGE_TTL_SEC = 48 * 3600;

/** The TXT value that completes a challenge. */
const amprTxtValue = (code: string) => `v=acs1; verify=${code}`;

/** POST /verify/ampr/start {callsign} — issue a code and name the exact record to publish. */
export async function startAmprChallenge(req: Request, env: Env): Promise<Response> {
  const c = await holderOf(req, env);
  if (c instanceof Response) return c;
  const code = randomToken(16);
  const issued = await issueChallenge(env, c, "ampr_dns", code);
  if (!issued) return startsLimited();
  const { verify: name } = amprNames(c.cs);
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

/** The operator requires a DNSSEC-validated answer (`AMPR_REQUIRE_DNSSEC`). */
const dnssecRequired = (env: Env) => env.AMPR_REQUIRE_DNSSEC === "1" || env.AMPR_REQUIRE_DNSSEC === "true";

/** Fewest resolvers that must answer (and agree) for an answer without DNSSEC. */
const MIN_AGREEING = 2;

/** The TXT set of an answer, order- and duplicate-insensitive, for comparing resolvers. */
const txtSet = (a: TxtAnswer) => [...new Set(a.txts)].sort().join("\n");

/** POST /verify/ampr/check {callsign} — look the record up and verify the call when it checks out. */
export async function checkAmprChallenge(req: Request, env: Env): Promise<Response> {
  const c = await holderOf(req, env);
  if (c instanceof Response) return c;
  if (await completionLimited(env, c, "ampr_dns")) return startsLimited();
  const code = await openChallenge(env, c, "ampr_dns", AMPR_CHALLENGE_TTL_SEC);
  if (!code) return noChallenge();
  const { host, verify: name } = amprNames(c.cs);

  const refuse = async (error: string) => {
    await failAttempt(env, c, "ampr_dns", code);
    return json({ error, name }, { status: 422 });
  };
  // A name that does not resolve yet says nothing about the code, so it costs no attempt: the ARDC portal
  // publishes on its own schedule, and the holder checks again until it does.
  const notPublished = (detail = "") =>
    json(
      {
        error: `${name} is not published yet${detail} — the ARDC portal can take a while to publish a new record; try again later`,
        name,
      },
      { status: 422 },
    );
  const lookupFailed = (why: string) => json({ error: `${why} — try again later`, name }, { status: 502 });
  const carries = (a: TxtAnswer) => a.txts.some((t) => acsFields(t)?.get("verify") === code);
  const aliased = () =>
    refuse(`${name} answers through a CNAME — publish the TXT record at ${name} itself, inside ampr.org`);
  const verify = async (proof: string, note: string) => {
    if (!(await spendChallenge(env, c, "ampr_dns", code))) return noChallenge();
    const refused = await recordProof(env, c, "ampr_dns", { by: host, note });
    if (refused) return json({ error: refused }, { status: 409 });
    return json({ verified: true, callsign: c.cs, method: "ampr_dns", proof, claimed: !!c.claim });
  };
  const wrongCode = () => refuse(`${name} does not carry the current code — publish "${amprTxtValue(code)}"`);

  // The validating resolver first: an authenticated answer is the strong proof and settles it alone.
  let validated: TxtAnswer | null = null;
  let validatedErr = "";
  try {
    validated = await resolveTxt(env, name);
  } catch (e) {
    validatedErr = (e as Error).message;
  }
  if (validated?.alias) return aliased();
  if (validated?.dnssec) {
    if (validated.status === NXDOMAIN) return notPublished();
    if (validated.status !== 0) return refuse(`the lookup of ${name} failed (DNS status ${validated.status})`);
    if (!validated.exact) return refuse(`the answer for ${name} names another record`);
    if (!carries(validated)) return wrongCode();
    return verify("dnssec", "dnssec");
  }
  if (dnssecRequired(env)) {
    if (!validated) return lookupFailed(`the DNS lookup failed (${validatedErr})`);
    if (validated.status === NXDOMAIN) return notPublished();
    return refuse(
      `the answer for ${name} is not DNSSEC-validated, and this instance accepts only DNSSEC-validated ampr.org proofs — use another verification method`,
    );
  }

  // No DNSSEC: every independent resolver that answers must agree.
  const resolvers = amprResolvers(env);
  const results = await Promise.all(
    resolvers.map((url) =>
      resolveTxtAt(url, name).then(
        (a) => ({ url, a }),
        () => ({ url, a: null }),
      ),
    ),
  );
  const answered = results.flatMap((r) => (r.a ? [{ url: r.url, a: r.a }] : []));
  if (answered.length < MIN_AGREEING)
    return lookupFailed(
      `only ${answered.length} of ${resolvers.length} DNS resolvers answered, and without DNSSEC at least ${MIN_AGREEING} must agree`,
    );
  const hostOf = (url: string) => {
    try {
      return new URL(url).hostname;
    } catch {
      return url;
    }
  };
  if (answered.some((r) => r.a.alias)) return aliased();
  const nx = answered.filter((r) => r.a.status === NXDOMAIN);
  if (nx.length === answered.length) return notPublished();
  if (nx.length > 0 && answered.every((r) => r.a.status === NXDOMAIN || r.a.status === 0))
    return notPublished(` everywhere (${nx.map((r) => hostOf(r.url)).join(", ")} does not see it yet)`);
  const failing = answered.find((r) => r.a.status !== 0);
  if (failing)
    return refuse(`the DNS resolvers disagree: ${hostOf(failing.url)} answered DNS status ${failing.a.status}`);
  if (answered.some((r) => !r.a.exact)) return refuse(`the answer for ${name} names another record`);
  const set = txtSet(answered[0]!.a);
  const odd = answered.find((r) => txtSet(r.a) !== set);
  if (odd) return refuse(`the DNS resolvers disagree: ${hostOf(odd.url)} returns a different TXT set for ${name}`);
  if (!carries(answered[0]!.a)) return wrongCode();
  const hosts = answered.map((r) => hostOf(r.url));
  return verify(`${answered.length} resolvers`, `${answered.length} resolvers: ${hosts.join(", ")}`);
}
