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
 * public-broadcast APRS positions, federation per fed_scope, export/erase self-service), and names
 * who receives data, listing the mail transport's host and the push services only when they are
 * configured. Until the OPERATOR_* variables are set, both pages render a visible not-yet-configured
 * warning so an operator cannot ship the placeholders unnoticed.
 */
import type { Env } from "./env.js";
import { escapeHtml } from "./util/html.js";
import { mailTransport } from "./mail.js";
import { updateCheckOn } from "./updatecheck.js";

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
    ? `<div class=box><p><strong>${escapeHtml(op.name)}</strong><br>${op.address.map(escapeHtml).join("<br>")}</p>
<p>Contact: <a href="mailto:${escapeHtml(op.email)}">${escapeHtml(op.email)}</a></p></div>`
    : unconfigured;
  return page(
    "Imprint",
    `<h1>Imprint</h1>
<p>Operator of this aprscaching instance (${escapeHtml(env.INSTANCE ?? "unconfigured")}):</p>
${who}
<p class=m>aprscaching is free software (AGPL-3.0-or-later); every instance is run independently by
its operator. This page identifies the operator of <em>this</em> instance only — not the authors of
the software.</p>`,
  );
}

/** Who receives personal data from this instance or from the visitor's browser, as list items. */
function recipients(env: Env): string {
  const items: string[] = [];
  const mail = mailTransport(env);
  if (mail)
    items.push(`<li><strong>Email provider</strong> (${escapeHtml(mail.host)}) — your e-mail
  address and the text of each sign-in or digest mail, so that it can deliver them.</li>`);
  if (env.VAPID_PUBLIC && env.VAPID_PRIVATE)
    items.push(`<li><strong>Browser push services</strong> — when you turn on notifications, the push service of
  your browser's vendor receives each notification, encrypted, and delivers it to your device.</li>`);
  items.push(`<li><strong>Map tile hosts</strong> — your browser loads the map directly from the basemap host
  (OpenFreeMap, tiles.openfreemap.org, unless the operator set another), and from OpenTopoMap
  (tile.opentopomap.org) or EOX (tiles.maps.eox.at) only when you choose the Topo or Satellite layer. Each host
  sees your IP address and the map area you view.</li>`);
  items.push(`<li><strong>APRS-IS and radio</strong> — positions, messages and find announcements this instance
  sends for you go out on the public APRS network, where any station or website can receive and keep
  them.</li>`);
  items.push(`<li><strong>Federation peers</strong> — if this instance federates, it shares signed records of
  its own caches (except local-only ones) and of their finds with peer instances, under each record's
  federation scope. Owner contact fields are redacted, and deletions propagate as signed tombstones.
  Imported places are never shared.</li>`);
  if (updateCheckOn(env))
    items.push(`<li><strong>GitHub</strong> (api.github.com) — once a day this instance asks GitHub whether a newer
  APRScaching release exists. The request names this instance and carries nothing about you.</li>`);
  return `<div class=box><ul>\n${items.join("\n")}\n</ul></div>`;
}

/** GET /privacy — what this instance processes; states the software's actual behavior. */
export function handlePrivacyPage(env: Env): Response {
  const op = operator(env);
  const contact = op.configured
    ? `<p>Controller for this instance: <strong>${escapeHtml(op.name)}</strong> — <a href="mailto:${escapeHtml(op.email)}">${escapeHtml(op.email)}</a>
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
<h2>Who receives data</h2>
${recipients(env)}
<h2>Your rights (GDPR)</h2>
<p>Export or erase everything tied to your account yourself under <em>Settings → Your data</em> — erasure
propagates to federation peers via signed tombstones. For anything else, contact the operator above.
You also have the right to complain to your supervisory authority.</p>
<h2>Hosting</h2>
<p>Where this instance's data physically lives depends on how the operator deploys it (own hardware,
a rented VM, a cloud instance or a phone). The operator can state specifics here via the imprint contact.</p>`,
  );
}
