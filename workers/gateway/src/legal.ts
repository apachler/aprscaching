// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * legal.ts — per-instance legal pages: the imprint (provider identification) and the privacy
 * notice. Like the AGPL §13 source link, these are obligations of WHOEVER RUNS an instance, not of
 * the project — so they are served by the gateway and filled from the operator's environment:
 *
 *   OPERATOR_NAME     the natural/legal person operating this instance (imprint requirement)
 *   OPERATOR_ADDRESS  a postal address ("," separates lines)
 *   OPERATOR_EMAIL    a reachable contact address (also the privacy contact)
 *
 *   GET /imprint    provider identification (Impressum — ECG §5 / MStV where applicable)
 *   GET /privacy    what this instance processes, why, for how long, and the user's GDPR tools
 *
 * The privacy text states what the software ACTUALLY does (session cookie only, callsign accounts,
 * public-broadcast APRS positions, federation per fed_scope, export/erase self-service). Until the
 * OPERATOR_* variables are set, both pages render a visible not-yet-configured warning so an
 * operator cannot ship the placeholders unnoticed.
 */
import type { Env } from "./env.js";

const esc = (s: string) => s.replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" })[c]!);

const STYLE = `<style>
:root{color-scheme:dark light}body{font:15px/1.5 system-ui,sans-serif;max-width:46rem;margin:2rem auto;padding:0 1rem}
h1{font-size:1.4rem}h2{font-size:1.1rem;margin-top:1.5rem}.m{opacity:.7}
.box{border:1px solid #8884;border-radius:10px;padding:1rem;margin:1rem 0}
.warn{border:1px solid #c66;border-radius:10px;padding:1rem;margin:1rem 0;background:#c661}
</style>`;

function operator(env: Env): { name: string; address: string[]; email: string; configured: boolean } {
  const name = env.OPERATOR_NAME?.trim() ?? "";
  const address = (env.OPERATOR_ADDRESS ?? "")
    .split(",")
    .map((l) => l.trim())
    .filter(Boolean);
  const email = env.OPERATOR_EMAIL?.trim() ?? "";
  return { name, address, email, configured: !!(name && email) };
}

const unconfigured = `<div class=warn><strong>This instance's operator has not configured this page yet.</strong>
Set <code>OPERATOR_NAME</code>, <code>OPERATOR_ADDRESS</code>, and <code>OPERATOR_EMAIL</code> in the
gateway environment before making the instance public.</div>`;

const page = (title: string, body: string): Response =>
  new Response(
    `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">
<title>${title} · aprscaching</title>${STYLE}${body}
<p class=m><a href="/imprint">Imprint</a> · <a href="/privacy">Privacy</a> · <a href="/source" rel="noopener">Source (AGPL-3.0)</a></p>`,
    { headers: { "content-type": "text/html; charset=utf-8" } },
  );

/** GET /imprint — provider identification for this instance. */
export function handleImprintPage(env: Env): Response {
  const op = operator(env);
  const who = op.configured
    ? `<div class=box><p><strong>${esc(op.name)}</strong><br>${op.address.map(esc).join("<br>")}</p>
<p>Contact: <a href="mailto:${esc(op.email)}">${esc(op.email)}</a></p></div>`
    : unconfigured;
  return page(
    "Imprint",
    `<h1>Imprint</h1>
<p>Operator of this aprscaching instance (${esc(env.INSTANCE ?? "unconfigured")}):</p>
${who}
<p class=m>aprscaching is free software (AGPL-3.0-or-later); every instance is run independently by
its operator. This page identifies the operator of <em>this</em> instance only — not the authors of
the software.</p>`,
  );
}

/** GET /privacy — what this instance processes; states the software's actual behavior. */
export function handlePrivacyPage(env: Env): Response {
  const op = operator(env);
  const contact = op.configured
    ? `<p>Controller for this instance: <strong>${esc(op.name)}</strong> — <a href="mailto:${esc(op.email)}">${esc(op.email)}</a>
(see the <a href="/imprint">imprint</a>).</p>`
    : unconfigured;
  return page(
    "Privacy",
    `<h1>Privacy notice</h1>
${contact}
<h2>What this instance stores</h2>
<div class=box><ul>
<li><strong>Account data</strong> — your amateur-radio callsign, optional display profile fields you
  choose to publish, an optional e-mail address (only if you use e-mail sign-in), and passkey public
  keys. Profiles are thin and opt-in; there is no name/address directory.</li>
<li><strong>Radio traffic</strong> — APRS packets (positions, messages, weather, telemetry) received
  from the public APRS-IS network and radio links. These are broadcasts every amateur station
  transmits publicly by design; short-lived firehose positions are pruned on a retention schedule,
  while positions that verify a cache find are kept longer as the find's evidence.</li>
<li><strong>Game data</strong> — caches you hide, finds you log, ratings, and media you upload.</li>
<li><strong>Technical minimum</strong> — one session cookie (sign-in only, no tracking), and
  short-lived per-IP counters for rate limiting. No analytics, no advertising, no third-party
  trackers.</li>
</ul></div>
<h2>Federation</h2>
<p>If this instance federates, signed cache/find records are shared with peer instances under the
record's federation scope; deletions propagate as signed tombstones. Owner contact fields are
redacted from federated records.</p>
<h2>Your rights (GDPR)</h2>
<p>Export or erase everything tied to your account yourself under <em>Settings → Data</em> — erasure
propagates to federation peers via signed tombstones. For anything else, contact the operator above.
You also have the right to complain to your supervisory authority.</p>
<h2>Hosting</h2>
<p>Where this instance's data physically lives depends on how the operator deploys it (own hardware,
a VM, or Cloudflare Workers/D1/R2). The operator can state specifics here via the imprint contact.</p>`,
  );
}
