// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * legal.ts — per-instance legal pages: the imprint (provider identification) and the privacy
 * notice. Like the AGPL §13 source link, these are obligations of WHOEVER RUNS an instance, not of
 * the project — so they are served by the gateway and filled from the operator's site settings (Instance
 * settings, or the environment, which wins):
 *
 *   OPERATOR_NAME      the natural/legal person operating this instance (imprint requirement)
 *   OPERATOR_ADDRESS   a postal address ("," separates lines)
 *   OPERATOR_EMAIL     a reachable contact address (also the privacy contact)
 *   EDITORIAL_LINE     optional: the site's editorial line, on the imprint
 *   PRIVACY_AUTHORITY  optional: the supervisory authority a complaint goes to ("," separates lines)
 *   HOSTING_PROVIDER   optional: who hosts the instance and where, a recipient on the privacy notice
 *
 *   GET /imprint    provider identification (ECG §5, MedienG §25, MStV where applicable)
 *   GET /privacy    the GDPR Art. 13/14 notice: each purpose with its data, legal basis and retention,
 *                   the recipients, what the browser stores, and the data subject's rights
 *
 * The privacy text states what the software ACTUALLY does, and reads every period it names from the
 * same constants and settings the nightly prune uses (retention.ts and the modules it calls), so the page
 * and the prune cannot disagree. It names a recipient only when the configuration brings it in: the mail
 * transport's host, the push services, a Cloudflare edge (TRUST_CF), the hosting provider and GitHub's
 * update check. Until the OPERATOR_* settings are set, both pages render a visible not-yet-configured
 * warning so an operator cannot ship the placeholders unnoticed.
 */
import type { Env } from "./env.js";
import { escapeHtml } from "./util/html.js";
import { mailTransport } from "./mail.js";
import { updateCheckOn } from "./updatecheck.js";
import { moderationKeepDays, POSITION_RETENTION_S, retentionFrom, STATION_KEEP_S } from "./retention.js";
import { meshcomNodeKeepDays } from "./meshcom.js";
import { MAILBOX_KEEP_SEC, MAILBOX_TTL_SEC } from "./mailbox.js";
import { BULLETIN_LIFETIME_SEC } from "./bbs.js";
import { setting } from "./siteconfig.js";

const STYLE = `<style>
:root{color-scheme:dark light}body{font:15px/1.5 system-ui,sans-serif;max-width:46rem;margin:2rem auto;padding:0 1rem}
h1{font-size:1.4rem}h2{font-size:1.1rem;margin-top:1.5rem}h3{font-size:1rem;margin:1rem 0 .25rem}.m{opacity:.7}
.box{border:1px solid #8884;border-radius:10px;padding:1rem;margin:1rem 0}
.warn{border:1px solid #c66;border-radius:10px;padding:1rem;margin:1rem 0;background:#c661}
</style>`;

const DAY_S = 86_400;
/** The session lifetime when SESSION_TTL_DAYS is unset or unusable, as auth.ts applies it. */
const SESSION_TTL_DAYS_DEFAULT = 30;

/** A comma-separated setting as trimmed, non-empty lines. */
const lines = (v: string | undefined): string[] =>
  (v ?? "")
    .split(",")
    .map((l) => l.trim())
    .filter(Boolean);

function operator(env: Env): { name: string; address: string[]; email: string; configured: boolean } {
  const name = setting(env, "OPERATOR_NAME")?.trim() ?? "";
  const address = lines(setting(env, "OPERATOR_ADDRESS"));
  const email = setting(env, "OPERATOR_EMAIL")?.trim() ?? "";
  return { name, address, email, configured: !!(name && email) };
}

const unconfigured = `<div class=warn><strong>This instance's operator has not configured this page yet.</strong>
The operator sets their name, postal address and contact email under Instance admin → Instance settings
(or <code>OPERATOR_NAME</code>, <code>OPERATOR_ADDRESS</code> and <code>OPERATOR_EMAIL</code> in the gateway
environment) before making the instance public.</div>`;

const page = (title: string, body: string): Response =>
  new Response(
    `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">
<title>${title} · APRScaching</title>${STYLE}${body}
<p class=m><a href="/imprint">Imprint</a> · <a href="/privacy">Privacy</a> · <a href="/source" rel="noopener">Source (AGPL-3.0)</a></p>`,
    { headers: { "content-type": "text/html; charset=utf-8" } },
  );

/** A period in whole days, or hours below two days, as words. */
function period(seconds: number): string {
  if (seconds < 2 * DAY_S) {
    const h = Math.round(seconds / 3600);
    return h === 1 ? "1 hour" : `${h} hours`;
  }
  const d = Math.round(seconds / DAY_S);
  if (d === 365) return "one year";
  return `${d} days`;
}

/** GET /imprint — provider identification for this instance. */
export function handleImprintPage(env: Env): Response {
  const op = operator(env);
  const line = setting(env, "EDITORIAL_LINE")?.trim();
  const who = op.configured
    ? `<div class=box><p><strong>${escapeHtml(op.name)}</strong><br>${op.address.map(escapeHtml).join("<br>")}</p>
<p>Contact: <a href="mailto:${escapeHtml(op.email)}">${escapeHtml(op.email)}</a></p>${
        line ? `\n<p>Editorial line: ${escapeHtml(line)}</p>` : ""
      }</div>`
    : unconfigured;
  return page(
    "Imprint",
    `<h1>Imprint</h1>
<p>Provider and owner of this APRScaching instance (${escapeHtml(env.INSTANCE ?? "unconfigured")}):</p>
${who}
<p class=m>APRScaching is free software (AGPL-3.0-or-later); every instance is run independently by
its operator. This page identifies the operator of <em>this</em> instance only — not the authors of
the software.</p>`,
  );
}

/** Who receives personal data from this instance or from the visitor's browser, as list items. */
function recipients(env: Env): string {
  const items: string[] = [];
  const hosting = setting(env, "HOSTING_PROVIDER")?.trim();
  if (hosting)
    items.push(`<li><strong>Hosting provider</strong> (${escapeHtml(hosting)}) — runs the machine this instance
  and its database live on, as a processor for the operator.</li>`);
  if (env.TRUST_CF === "1")
    items.push(`<li><strong>Cloudflare</strong> (Cloudflare, Inc., United States) — every request to this instance
  passes through Cloudflare's network on its way here, so Cloudflare processes your IP address and each request
  as the operator's processor. This is a transfer to a third country.</li>`);
  const mail = mailTransport(env);
  if (mail)
    items.push(`<li><strong>Email provider</strong> (${escapeHtml(mail.host)}) — your e-mail
  address and the text of each sign-in, digest or moderation mail, so that it can deliver them; the operator's
  address and the text of each report a player files.${
    mail.kind === "resend" ? " The Resend API is run by Resend, Inc. in the United States, a third country." : ""
  }</li>`);
  if (env.VAPID_PUBLIC && env.VAPID_PRIVATE)
    items.push(`<li><strong>Browser push services</strong> — when you turn on notifications, the push service of
  your browser's vendor (for example Google, Mozilla or Apple, which may sit outside the EU) receives each
  notification, encrypted so that only your device can read it, and delivers it to your device.</li>`);
  items.push(`<li><strong>Map tile hosts</strong> — your browser loads the map directly from the basemap host
  (OpenFreeMap, tiles.openfreemap.org, unless the operator set another), and from OpenTopoMap
  (tile.opentopomap.org) or EOX (tiles.maps.eox.at) only when you choose the Topo or Satellite layer. Each host
  sees your IP address and the map area you view.</li>`);
  items.push(`<li><strong>APRS-IS and radio</strong> — positions, messages and find announcements this instance
  sends for you go out on the public APRS network, where any station or website can receive and keep
  them.</li>`);
  items.push(`<li><strong>Federation peers</strong> — if this instance federates, it shares signed records of
  its own caches (except local-only ones) and of their finds (the logger's callsign, the time, the kind of log,
  the verification tier and the comment) with peer instances, under each record's federation scope, together
  with the device public keys that sign them and the record of an account moved to another instance. Owner
  contact fields are redacted, and deletions propagate as signed tombstones. To verify a find it may ask peers
  whether they heard your callsign near the cache, naming only a square of about 550 m and a 10-minute window.
  Imported places are never shared.</li>`);
  if (updateCheckOn(env))
    items.push(`<li><strong>GitHub</strong> (api.github.com) — once a day this instance asks GitHub whether a newer
  APRScaching release exists. The request names this instance and carries nothing about you.</li>`);
  return `<div class=box><ul>\n${items.join("\n")}\n</ul>
<p>Where a recipient sits outside the EU/EEA, the operator tells you on request which safeguard (GDPR Art. 45 or
46) covers the transfer. No data is sold, and nothing goes to advertisers or analytics services.</p></div>`;
}

/** The purposes this instance processes personal data for, each with its data, legal basis and retention. */
function purposes(env: Env): string {
  const keep = retentionFrom(env);
  const sessionDays = Number(env.SESSION_TTL_DAYS ?? SESSION_TTL_DAYS_DEFAULT) || SESSION_TTL_DAYS_DEFAULT;
  const days = (n: number) => (n === 1 ? "1 day" : `${n} days`);
  return `<div class=box>
<h3>Your account and sign-in</h3>
<p>Your amateur-radio callsign and the calls you hold, their control-verification, an optional e-mail address
  (only if you use e-mail sign-in or the digest), and your passkeys' public keys. Profiles are thin and opt-in;
  there is no name/address directory.<br>
  <em>Legal basis:</em> providing the service you sign up for (GDPR Art. 6(1)(b)).<br>
  <em>Kept:</em> until you erase your account. The sign-in cookie expires after ${days(sessionDays)}; e-mail
  sign-in links are deleted a day after they are used, and two days after they were sent at the latest.</p>

<h3>Playing</h3>
<p>Caches you hide, finds and notes you log (callsign, time, comment and how the find was verified), ratings,
  favourites, watched caches, and media you upload. When you log a find in the app, your device's location at that
  moment is compared with the cache; only the distance and the result are kept, not the location. Your browser
  scales a photo larger than 1600 pixels down before uploading it, which drops its embedded metadata (such as a
  GPS position); a smaller photo is stored as you upload it, metadata included.<br>
  <em>Legal basis:</em> providing the service (Art. 6(1)(b)).<br>
  <em>Kept:</em> until you delete it or erase your account. Erasure replaces your callsign on your finds with a
  withdrawn marker and archives your caches, so other players' counts stay right.</p>

<h3>Features you switch on</h3>
<p>The public profile card, the e-mail digest, push notifications, announcing your finds on APRS-IS, and the
  near-cache radio message are off until you turn them on.<br>
  <em>Legal basis:</em> your consent (Art. 6(1)(a)). Switching a feature off in Settings withdraws it for the
  future (Art. 7(3)); what was already sent on the air stays there.<br>
  <em>Kept:</em> until you switch it off or erase your account.</p>

<h3>Stations heard on the air</h3>
<p>APRS and MeshCom packets (positions, messages, weather, telemetry, station and node details) that licensed
  stations broadcast publicly, received from the public APRS-IS network and from radio. They come from the
  broadcast, not from you, and concern every station heard, with or without an account here. They feed the live
  map, the Shack and the verification of finds.<br>
  <em>Legal basis:</em> the operator's legitimate interest in showing and verifying public amateur-radio traffic
  (Art. 6(1)(f)); you may object (below).<br>
  <em>Kept:</em> positions ${period(POSITION_RETENTION_S)}; raw packets ${period(keep.packetsHours * 3600)};
  messages and MeshCom group messages ${days(keep.messagesDays)}; weather and telemetry readings
  ${days(keep.sensorDays)}; MeshCom nodes ${days(meshcomNodeKeepDays(env))} after last heard; a station's map entry
  ${period(STATION_KEEP_S)} after last heard, or while a living cache, a registered station or a MeshCom node
  names it. Mailbox messages wait ${period(MAILBOX_TTL_SEC)} for their station and are deleted
  ${period(MAILBOX_KEEP_SEC)} after that; BBS bulletins expire after ${period(BULLETIN_LIFETIME_SEC)} unless
  they set another expiry; personal BBS mail stays until its recipient deletes it.</p>

<h3>Moderation</h3>
<p>Reports players file (the item, a category, the reporter's words and, when signed
  in, the reporter's call) and the operator's record of each moderation action and suspension, kept to answer
  abuse (legitimate interest, Art. 6(1)(f)). A settled report and the record of an action are deleted after
  ${moderationKeepDays(env)} days; an open report stays until it is settled, and the record of a suspension while it
  holds. If you erase your account while it is suspended, your callsigns keep a record of
  the suspension (the callsign, its category and its end, nothing else) until it ends or the operator lifts it, so
  they cannot be registered again before then. Your export includes the actions about your account; who reported
  you is not shown to you.</p>

<h3>Callsign changes</h3>
<p>A claim to take over a callsign and each change of a callsign's holder, kept for one year to answer a dispute
  over the call (legitimate interest, Art. 6(1)(f)).</p>

<h3>Security and abuse protection</h3>
<p>Your IP address is used for each request and counted against per-address rate limits; the nightly cleanup
  deletes a counter once its window (at most a day) has ended. The gateway keeps no access log of your requests; error messages it prints go to the host's log, which the
  operator's deployment rotates. Backup copies of the database let the operator restore the instance after a failure;
  an erased record leaves the backups when the oldest copy holding it is deleted.<br>
  <em>Legal basis:</em> the operator's legitimate interest in a secure, available service (Art. 6(1)(f)).</p>
</div>`;
}

/** GET /privacy — what this instance processes; states the software's actual behavior. */
export function handlePrivacyPage(env: Env): Response {
  const op = operator(env);
  const contact = op.configured
    ? `<p>Controller for this instance: <strong>${escapeHtml(op.name)}</strong>${
        op.address.length ? `, ${op.address.map(escapeHtml).join(", ")}` : ""
      } — <a href="mailto:${escapeHtml(op.email)}">${escapeHtml(op.email)}</a>
(see the <a href="/imprint">imprint</a>).</p>`
    : unconfigured;
  const authority = lines(setting(env, "PRIVACY_AUTHORITY"));
  const complain = authority.length
    ? `the supervisory authority: <strong>${authority.map(escapeHtml).join(", ")}</strong>, or the one where you live or
  work`
    : "a data-protection supervisory authority, in particular the one where you live or work";
  return page(
    "Privacy",
    `<h1>Privacy notice</h1>
${contact}
<h2>What this instance processes, why, and for how long</h2>
${purposes(env)}
<h2>Who receives data</h2>
${recipients(env)}
<h2>What your browser stores</h2>
<p>One session cookie while you are signed in (no tracking cookie), and in the browser's own storage your settings,
your device's signing key and the maps and caches you keep for offline use. They are needed for the service you
use, and are never read for tracking. No analytics, no advertising, no third-party trackers.</p>
<h2>Your rights (GDPR)</h2>
<div class=box><ul>
<li><strong>Access and portability</strong> (Art. 15, 20) — export everything tied to your account, in a
  machine-readable form, under <em>Settings → Your data</em>.</li>
<li><strong>Erasure</strong> (Art. 17) — erase your account there yourself; the erasure propagates to federation
  peers via signed tombstones.</li>
<li><strong>Rectification</strong> (Art. 16) — edit your profile and your content in the app, or ask the
  operator.</li>
<li><strong>Restriction</strong> (Art. 18) and <strong>objection</strong> (Art. 21) — you may object at any time,
  on grounds relating to your situation, to processing based on legitimate interest, including what this instance
  stores about your station from the air. Write to the operator above.</li>
<li><strong>Withdrawing consent</strong> (Art. 7(3)) — switch the feature off in Settings; this does not affect
  what was done before.</li>
<li><strong>Complaint</strong> (Art. 77) — you may complain to ${complain}.</li>
</ul></div>
<p>An account needs only a callsign; the e-mail address is optional, and without one you sign in with a passkey.
Nothing is decided about you by automated means with legal or similarly significant effect (Art. 22): the
verification tier of a find is a game result.</p>
<h2>Hosting</h2>
<p>Where this instance's data physically lives depends on how the operator deploys it (own hardware,
a rented VM, a cloud instance or a phone)${
      setting(env, "HOSTING_PROVIDER")?.trim() ? "; the hosting provider is named above" : ""
    }. The operator answers questions about it at the contact above.</p>`,
  );
}
