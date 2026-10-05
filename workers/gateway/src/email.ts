// SPDX-License-Identifier: AGPL-3.0-or-later
import { nowS } from "./util/time.js";
import { escapeHtml } from "./util/html.js";
import type { Env } from "./env.js";
import { baseCall } from "@aprscaching/aprs";
import { json, corsAllowlist } from "./app.js";
import { reclaimStatements } from "./claims.js";
import {
  issueSessionCookie,
  unclaimableReason,
  callRefusal,
  refusalResponse,
  isFormerMarker,
  authThrottled,
  sessionsEnabled,
  sessionUnavailable,
  holdCall,
  baseHolder,
  isRegistrableCall,
  operatorSecretOk,
  signInPaths,
  sessionIdentity,
  AccountSuspended,
  suspendedResponse,
} from "./auth.js";
import { adminCalls } from "./admin.js";
import { licenceFor } from "./licence.js";
import { appBase, gatewayBase } from "./sitemap.js";
import { hotspotOrigin, linkOrigin } from "./visitor.js";
import { sendEmail } from "./mail.js";

/**
 * Email magic-link auth: the passwordless recovery / no-authenticator path that complements
 * passkeys. `start` issues a one-time token and emails a link. Opening the link (GET) only shows a
 * confirm step; the confirm (POST with the same token) consumes it and opens a session, creating the
 * account on first register. A GET never signs anyone in, so a page that makes a browser load someone
 * else's link cannot log the victim into the attacker's account. When no mail transport is configured
 * (dev/CI), `start` returns the token in-band so headless flows and first-run can proceed without mail.
 *
 * The same token store and confirm step carry the operator-issued sign-in link (`handleOperatorLink`),
 * the sign-in path of an instance with neither passkeys nor email.
 */

const TTL_SEC = 15 * 60;
/** The token purpose of an operator-issued link: it names a call, not a mailbox. */
const OPERATOR_PURPOSE = "operator";
/** The token purpose of an address confirmation: it binds a pending address to the account that gave it. */
const CONFIRM_PURPOSE = "confirm";
/** A confirmation mail may sit unread for a day; a sign-in link lives 15 minutes. */
const CONFIRM_TTL_SEC = 24 * 3600;
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** A well-formed address, trimmed and lower-cased, or null. */
export function normalEmail(raw: unknown): string | null {
  const e = (typeof raw === "string" ? raw : "").trim().toLowerCase();
  return EMAIL_RE.test(e) ? e : null;
}

function newToken(): string {
  return (crypto.randomUUID() + crypto.randomUUID()).replace(/-/g, "");
}
/** The shape {@link newToken} produces: 64 lowercase hex digits. Anything else is not a sign-in token. */
const TOKEN_SHAPE = /^[0-9a-f]{64}$/;
function appOrigin(req: Request, env: Env): string {
  return env.APP_URL ?? new URL(req.url).origin;
}

/** POST /auth/email/start {email, callsign?} — begin email register (needs callsign) or login. */
export async function handleEmailStart(req: Request, env: Env): Promise<Response> {
  const { email, callsign } = (await req.json().catch(() => ({}))) as { email?: string; callsign?: string };
  const e = String(email ?? "")
    .trim()
    .toLowerCase();
  if (!EMAIL_RE.test(e)) return json({ error: "invalid email" }, { status: 400 });
  // each start sends a mail: bound it per client address and per mailbox
  const limited = await authThrottled(env, req, "email-start", e, { perIp: 20, perIdentity: 5, windowMs: 600_000 });
  if (limited) return limited;

  const acct = await env.DB.prepare("SELECT account_id, callsign FROM accounts WHERE email = ?")
    .bind(e)
    .first<{ account_id: string; callsign: string }>();
  const purpose = acct ? "login" : "register";
  // an account whose last call moved to its licensee signs in again with the call it operates now
  const callless = !!acct && isFormerMarker(acct.callsign);
  let cs: string | null = null;
  if (purpose === "register" || callless) {
    cs = String(callsign ?? "")
      .toUpperCase()
      .trim();
    if (cs.length < 3)
      return callless
        ? json(
            {
              error: "your account holds no callsign now — give the callsign you operate to sign in with it",
              reason: "needs_callsign",
            },
            { status: 409 },
          )
        : json({ error: "callsign required to register" }, { status: 400 });
    const refused = await callRefusal(env, cs);
    if (refused) return refusalResponse(refused);
  }

  const token = newToken();
  await env.DB.prepare(
    "INSERT INTO email_tokens (token, email, callsign, purpose, created_at, used) VALUES (?, ?, ?, ?, ?, 0)",
  )
    .bind(token, e, cs, purpose, nowS())
    .run();

  // The link opens this gateway's confirm page. It names the gateway's own public origin, which is the
  // app's origin wherever the two share a host; an app served from another host (a static site in front
  // of an API host) does not route /auth/* to the gateway, so a link to it would open the app instead.
  const link = `${gatewayBase(req, env)}/auth/email/verify?token=${token}`;
  const sent = await sendEmail(
    env,
    e,
    "Your aprscaching sign-in link",
    `Sign in to aprscaching:\n${link}\n\nThis link expires in 15 minutes. If you didn't request it, ignore this email.`,
  );
  if (sent) return json({ sent: true, purpose });
  // The sign-in token must NOT be handed back to the caller on a real instance. Returning
  // it in-band is a dev/CI convenience that is account-takeover in production — gate it behind an
  // explicit opt-in, never merely "email isn't configured". Off ⇒ fail closed.
  if (env.ALLOW_DEV_TOKENS === "1" || env.ALLOW_DEV_TOKENS === "true") {
    console.log(`dev sign-in link for ${e}: ${link}`); // the server log stands in for the mailbox
    return json({ sent: false, purpose, devToken: token, devLink: link });
  }
  return json({ error: "email delivery is not configured on this instance" }, { status: 503 });
}

/**
 * POST /auth/operator-link {callsign} with `x-operator-secret` — the operator mints a single-use sign-in
 * link that expires in 15 minutes (`tools/admin/signin-link.mjs`). It opens the account holding the call's
 * base call, or creates an unverified account for a new call; it never verifies a callsign. The link
 * runs through the same confirm step as an email link, so opening it signs nobody in.
 *
 * Scope: on an off-grid instance (no passkey origin, no email) it serves every call, since it is the only
 * way in. Where passkeys or email work it serves only ADMIN_CALLSIGNS calls, so a leaked operator secret
 * cannot open a member's account there — unless the operator sets OPERATOR_LINKS_FOR_ANY_CALL=1: an
 * off-grid station whose owner signs in with a passkey on localhost, and whose visitors on its hotspot
 * have no other way in.
 *
 * `base` picks the origin the link names: APP_URL, or the station's hotspot origin (visitor.ts), the only
 * one a visitor's phone can open. Any other value is refused, so the link never points anywhere else.
 */
export async function handleOperatorLink(req: Request, env: Env): Promise<Response> {
  if (!operatorSecretOk(req, env)) return new Response("unauthorized", { status: 401 });
  if (!sessionsEnabled(env)) return sessionUnavailable();
  const body = (await req.json().catch(() => ({}))) as { callsign?: string; base?: unknown };
  const cs = String(body.callsign ?? "")
    .toUpperCase()
    .trim();
  if (!isRegistrableCall(cs)) return json({ error: "a valid, unreserved callsign is required" }, { status: 400 });
  const requested = body.base === undefined ? null : typeof body.base === "string" ? linkOrigin(body.base, env) : null;
  if (body.base !== undefined && requested === null)
    return json(
      { error: "base must be APP_URL or this station's https hotspot origin (a private IPv4 address on HTTPS_PORT)" },
      { status: 400 },
    );
  const base = baseCall(cs);
  const paths = signInPaths(env);
  const offGrid = !paths.passkeys && !paths.email;
  const anyCall = offGrid || env.OPERATOR_LINKS_FOR_ANY_CALL === "1";
  const admin = [...adminCalls(env)].some((c) => baseCall(c) === base);
  if (!anyCall && !admin)
    return json(
      {
        error:
          "this instance offers passkey or email sign-in, so an operator link serves only ADMIN_CALLSIGNS calls (OPERATOR_LINKS_FOR_ANY_CALL=1 lifts this on an off-grid station)",
      },
      { status: 403 },
    );

  const existing = (await baseHolder(env, base)) !== null;
  const token = newToken();
  await env.DB.prepare(
    "INSERT INTO email_tokens (token, email, callsign, purpose, created_at, used) VALUES (?, '', ?, ?, ?, 0)",
  )
    .bind(token, cs, OPERATOR_PURPOSE, nowS())
    .run();
  // A script on the box reaches the gateway over loopback, which no other device can open: the link then
  // names the app origin. Reached on a public host (an API host beside a static app), it names that host.
  const onLoopback = LOOPBACK_HOSTS.has(new URL(req.url).hostname);
  const origin = requested ?? (onLoopback && env.APP_URL ? appBase(env) : gatewayBase(req, env));
  console.log(`operator sign-in link issued for ${cs} (${existing ? "existing" : "new"} account)`);
  return json({
    link: `${origin}/auth/email/verify?token=${token}`,
    callsign: cs,
    account: existing ? "existing" : "new",
    expiresIn: TTL_SEC,
  });
}

/**
 * The confirm step a browser sees when it opens the link: one button that POSTs the token back. The
 * `same-origin` referrer policy keeps the token-bearing URL from reaching any other site, while the form
 * POST still carries this page's origin — under `no-referrer` a browser sends `Origin: null`, which the
 * origin check refuses.
 */
function confirmPage(token: string): Response {
  return new Response(
    `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">
<meta name=referrer content=same-origin>
<title>Sign in · aprscaching</title><style>
:root{color-scheme:dark light}body{font:15px/1.5 system-ui,sans-serif;max-width:30rem;margin:3rem auto;padding:0 1rem}
h1{font-size:1.4rem}.m{opacity:.7}button{font:inherit;font-weight:600;min-height:44px;padding:.6rem 1.2rem;border-radius:10px}
button:focus-visible{outline:2px solid currentColor;outline-offset:2px}</style>
<h1>Sign in to aprscaching</h1>
<p>Confirm that you want to sign in on this device.</p>
<form method="post" action="/auth/email/verify"><input type="hidden" name="token" value="${escapeHtml(token)}">
<button type="submit">Sign in</button></form>
<p class=m>Didn't request this? Close this page — nothing happens until you confirm.</p>`,
    {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "referrer-policy": "same-origin",
      },
    },
  );
}

/** A browser POST must come from this gateway's own page or the configured app origins. A request with
 *  no Origin header is a non-browser client (a script holding the token), which no page can forge. */
function sameSiteOrigin(req: Request, env: Env): boolean {
  const origin = req.headers.get("origin");
  if (origin === null) return true;
  try {
    const o = new URL(origin);
    return o.host === new URL(req.url).host || corsAllowlist(env).has(o.origin);
  } catch {
    return false; // "null" (sandboxed/opaque) or garbage
  }
}

/**
 * GET /auth/email/verify?token= — the link target: a confirm page for a browser, `{ confirm: true }` for
 * an API client. Never consumes the token.
 * POST /auth/email/verify {token} (JSON or a form) — consume the token and open a session.
 */
export async function handleEmailVerify(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  if (req.method === "GET") {
    const token = url.searchParams.get("token");
    if (!token) return json({ error: "missing token" }, { status: 400 });
    // only a well-formed token ever reaches the HTML page, so nothing a link carries is reflected into it
    if (!TOKEN_SHAPE.test(token)) return json({ error: "invalid token" }, { status: 400 });
    if ((req.headers.get("accept") ?? "").includes("text/html")) return confirmPage(token);
    return json({ confirm: true, method: "POST", path: "/auth/email/verify" });
  }

  if (!sameSiteOrigin(req, env)) return json({ error: "cross-site sign-in refused" }, { status: 403 });
  const isForm = (req.headers.get("content-type") ?? "").includes("application/x-www-form-urlencoded");
  const token = isForm
    ? new URLSearchParams(await req.text().catch(() => "")).get("token")
    : (((await req.json().catch(() => ({}))) as { token?: string }).token ?? null);
  if (!token) return json({ error: "missing token" }, { status: 400 });
  if (!sessionsEnabled(env)) return sessionUnavailable();

  const row = await env.DB.prepare(
    "SELECT email, callsign, purpose, created_at, used FROM email_tokens WHERE token = ?",
  )
    .bind(token)
    .first<{ email: string; callsign: string | null; purpose: string; created_at: number; used: number }>();
  const now = nowS();
  const ttl = row?.purpose === CONFIRM_PURPOSE ? CONFIRM_TTL_SEC : TTL_SEC;
  if (!row || row.used || now - row.created_at > ttl) {
    return json({ error: "invalid or expired link" }, { status: 400 });
  }
  // spend the token atomically: of two concurrent confirms only one sees the row still unused
  const spent = await env.DB.prepare("UPDATE email_tokens SET used = 1 WHERE token = ? AND used = 0").bind(token).run();
  if (spent.meta?.changes === 0) return json({ error: "invalid or expired link" }, { status: 400 });

  const acct =
    row.purpose === OPERATOR_PURPOSE
      ? await operatorLinkAccount(env, row.callsign ?? "", now)
      : row.purpose === CONFIRM_PURPOSE
        ? await confirmedAccount(env, row.email, row.callsign ?? "")
        : await emailAccount(env, row.email, row.callsign, now);
  if (acct instanceof Response) return acct;

  let cookie: string;
  try {
    cookie = await issueSessionCookie(env, acct.account_id, acct.callsign);
  } catch (e) {
    if (e instanceof AccountSuspended) return suspendedResponse(e);
    throw e;
  }
  // the confirm form → back into the app with the session set; an API client → JSON. A visitor who
  // confirmed on the station's hotspot origin returns there: APP_URL is the owner's localhost.
  if (isForm) {
    const back = hotspotOrigin(url.origin, env) ?? appOrigin(req, env);
    return new Response(null, { status: 303, headers: { "set-cookie": cookie, location: back + "/" } });
  }
  return json(
    { ok: true, callsign: acct.callsign, licence: await licenceFor(env, acct.callsign) },
    { headers: { "set-cookie": cookie } },
  );
}

type Acct = { account_id: string; callsign: string };

/** The account an email link signs in: the mailbox's account, or a new one registered under its call. */
async function emailAccount(env: Env, email: string, callsign: string | null, now: number): Promise<Acct | Response> {
  const acct = await env.DB.prepare("SELECT account_id, callsign FROM accounts WHERE email = ?")
    .bind(email)
    .first<Acct>();
  if (!acct) return createAccount(env, (callsign ?? "").toUpperCase(), email, now);
  if (!isFormerMarker(acct.callsign)) return acct;
  // the account holds no call: it takes on the call the link was asked for, and its content follows
  const cs = (callsign ?? "").toUpperCase();
  const refused = cs.length >= 3 ? await unclaimableReason(env, cs) : "missing callsign";
  if (refused) return json({ error: refused }, { status: 409 });
  try {
    await env.DB.batch(reclaimStatements(env, acct.account_id, acct.callsign, cs, now));
  } catch {
    return json({ error: "callsign already claimed" }, { status: 409 });
  }
  return { account_id: acct.account_id, callsign: cs };
}

/**
 * The account a confirmation link binds its address to: the holder of the call the address was given for,
 * while that address is still the one it waits for. The address then becomes the account's sign-in and
 * recovery email; an address already confirmed on another account stays there.
 */
async function confirmedAccount(env: Env, email: string, callsign: string): Promise<Acct | Response> {
  const holder = await baseHolder(env, baseCall(callsign));
  const acct = holder
    ? await env.DB.prepare("SELECT account_id, callsign, pending_email FROM accounts WHERE account_id = ?")
        .bind(holder)
        .first<Acct & { pending_email: string | null }>()
    : null;
  if (!acct || acct.pending_email !== email)
    return json({ error: "this address is no longer waiting for confirmation" }, { status: 400 });
  try {
    await env.DB.prepare(
      "UPDATE accounts SET email = ?, pending_email = NULL WHERE account_id = ? AND pending_email = ?",
    )
      .bind(email, acct.account_id, email)
      .run();
  } catch {
    return json({ error: "that address already belongs to another account" }, { status: 409 });
  }
  return { account_id: acct.account_id, callsign: acct.callsign };
}

/**
 * Mail a confirmation link for an address given at passkey registration. The address stays pending — it
 * signs nobody in, receives no mail and recovers nothing — until its owner opens the link. Without a mail
 * transport the token comes back in-band only on an instance that opts into dev tokens.
 */
export async function sendEmailConfirmation(
  req: Request,
  env: Env,
  email: string,
  callsign: string,
): Promise<{ sent: boolean; devToken?: string; devLink?: string }> {
  const token = newToken();
  await env.DB.prepare(
    "INSERT INTO email_tokens (token, email, callsign, purpose, created_at, used) VALUES (?, ?, ?, ?, ?, 0)",
  )
    .bind(token, email, callsign, CONFIRM_PURPOSE, nowS())
    .run();
  const link = `${gatewayBase(req, env)}/auth/email/verify?token=${token}`;
  const sent = await sendEmail(
    env,
    email,
    "Confirm your aprscaching email address",
    `Confirm this address for the aprscaching account of ${callsign}:\n${link}\n\nOnce confirmed, it signs you in and recovers the account. The link expires in 24 hours. If you did not create this account, ignore this email: the address is not used until it is confirmed.`,
  );
  if (sent) return { sent };
  if (env.ALLOW_DEV_TOKENS === "1" || env.ALLOW_DEV_TOKENS === "true") {
    console.log(`dev confirmation link for ${email}: ${link}`);
    return { sent, devToken: token, devLink: link };
  }
  return { sent };
}

/**
 * Mailing a confirmation is bounded per account and per client address, and a change and a resend draw on
 * the same budget, so neither path mails an inbox more often than the other allows.
 */
const CONFIRM_LIMITS = { perIp: 20, perIdentity: 5, windowMs: 3_600_000 };

/** Is `email` the confirmed address of an account other than `accountId`? Such an address stays there. */
async function confirmedElsewhere(env: Env, email: string, accountId: string): Promise<boolean> {
  return !!(await env.DB.prepare("SELECT 1 FROM accounts WHERE email = ? AND account_id != ?")
    .bind(email, accountId)
    .first());
}

/** The answer to a change or a resend: the waiting address and how its confirmation mail went. */
function confirmationSent(email: string, confirmation: Awaited<ReturnType<typeof sendEmailConfirmation>>): Response {
  if (!confirmation.sent && !confirmation.devToken)
    return json(
      { error: "the confirmation mail could not be sent — try again later", pendingEmail: email },
      { status: 503 },
    );
  return json({ ok: true, pendingEmail: email, ...confirmation });
}

/**
 * POST /auth/email/change {email} — give the signed-in account a new sign-in and recovery address, or its
 * first one. The address waits for confirmation like one given at registration; a confirmed address keeps
 * working until the new one is confirmed. Giving the confirmed address again drops a waiting one.
 */
export async function handleEmailChange(req: Request, env: Env): Promise<Response> {
  const me = await sessionIdentity(req, env);
  if (!me) return json({ error: "sign in first" }, { status: 401 });
  const { email } = (await req.json().catch(() => ({}))) as { email?: unknown };
  const e = normalEmail(email);
  if (!e) return json({ error: "invalid email" }, { status: 400 });
  const acct = await env.DB.prepare("SELECT email FROM accounts WHERE account_id = ?")
    .bind(me.accountId)
    .first<{ email: string | null }>();
  if (!acct) return json({ error: "sign in first" }, { status: 401 });
  if (acct.email === e) {
    await env.DB.prepare("UPDATE accounts SET pending_email = NULL WHERE account_id = ?").bind(me.accountId).run();
    return json({ ok: true, email: e, pendingEmail: null });
  }
  if (await confirmedElsewhere(env, e, me.accountId))
    return json({ error: "that address already belongs to another account" }, { status: 409 });
  const limited = await authThrottled(env, req, "email-confirm", me.accountId, CONFIRM_LIMITS);
  if (limited) return limited;
  await env.DB.prepare("UPDATE accounts SET pending_email = ? WHERE account_id = ?").bind(e, me.accountId).run();
  return confirmationSent(e, await sendEmailConfirmation(req, env, e, me.callsign));
}

/** POST /auth/email/resend — mail the confirmation link for the address the account is waiting on again. */
export async function handleEmailResend(req: Request, env: Env): Promise<Response> {
  const me = await sessionIdentity(req, env);
  if (!me) return json({ error: "sign in first" }, { status: 401 });
  const acct = await env.DB.prepare("SELECT pending_email FROM accounts WHERE account_id = ?")
    .bind(me.accountId)
    .first<{ pending_email: string | null }>();
  const e = acct?.pending_email ?? null;
  if (!e) return json({ error: "no address is waiting for confirmation" }, { status: 400 });
  if (await confirmedElsewhere(env, e, me.accountId))
    return json({ error: "that address already belongs to another account" }, { status: 409 });
  const limited = await authThrottled(env, req, "email-confirm", me.accountId, CONFIRM_LIMITS);
  if (limited) return limited;
  return confirmationSent(e, await sendEmailConfirmation(req, env, e, me.callsign));
}

/** The account an operator link signs in: the holder of the call's base call, or a new one for the call. */
async function operatorLinkAccount(env: Env, callsign: string, now: number): Promise<Acct | Response> {
  const holder = await baseHolder(env, baseCall(callsign));
  if (holder) {
    const acct = await env.DB.prepare("SELECT account_id, callsign FROM accounts WHERE account_id = ?")
      .bind(holder)
      .first<Acct>();
    if (acct) return acct;
  }
  return createAccount(env, callsign.toUpperCase(), null, now, { operatorLink: true });
}

/**
 * Register a durable account under `cs` (unverified control), with an optional recovery email. Only the
 * operator's link (`operatorLink`) registers an ADMIN_CALLSIGNS call this way.
 */
async function createAccount(
  env: Env,
  cs: string,
  email: string | null,
  now: number,
  o: { operatorLink?: boolean } = {},
): Promise<Acct | Response> {
  if (cs.length < 3) return json({ error: "missing callsign for registration" }, { status: 400 });
  // guard the race: the call (or its base, via another SSID) may have been claimed since the link was issued
  const refused = await unclaimableReason(env, cs, o);
  if (refused) return json({ error: refused }, { status: 409 });
  const id = crypto.randomUUID();
  try {
    // seed the held-callsign set with this call as the account's primary base call; the unique
    // base-call index makes a concurrent claim fail the whole batch
    await env.DB.batch([
      ...holdCall(env, id, baseCall(cs), true, now),
      env.DB.prepare("INSERT INTO accounts (callsign, account_id, email, created_at) VALUES (?, ?, ?, ?)").bind(
        cs,
        id,
        email,
        now,
      ),
      env.DB.prepare("INSERT INTO callsign_history (account_id, callsign, set_at, verified) VALUES (?, ?, ?, 0)").bind(
        id,
        cs,
        now,
      ),
    ]);
  } catch {
    return json({ error: "callsign already claimed" }, { status: 409 });
  }
  return { account_id: id, callsign: cs };
}
