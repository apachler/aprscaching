// SPDX-License-Identifier: AGPL-3.0-or-later
import { nowS } from "./util/time.js";
import type { Env } from "./env.js";
import { baseCall } from "@aprscaching/aprs";
import { corsAllowlist } from "./app.js";
import { json } from "./http.js";
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
  suspensionOf,
} from "./auth.js";
import { adminCalls } from "./admin.js";
import { licenceFor } from "./licence.js";
import { appBase, gatewayBase } from "./sitemap.js";
import { linkOrigin } from "./visitor.js";
import { instanceOrigins, isInstanceOrigin, requestOrigin } from "./origins.js";
import { sendEmail } from "./mail.js";
import { linkPageResponse, wantsPage } from "./linkpage.js";

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
/**
 * The token purpose of a link to an account's data: it opens a session that only exports or erases the data of
 * an account holding no call (its last call moved to the call's licensee, claims.ts). Such an account has no
 * other way in until it takes a call on, and its owner keeps the rights of access and erasure meanwhile.
 */
const ACCOUNT_DATA_PURPOSE = "account-data";
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

/**
 * The verify link of a token, on this gateway's address for the request. When the page that asked for the link
 * is another address of this instance (a web app on another host than its gateway), the link names that page's
 * origin as `app`, where the confirm step returns to.
 */
function verifyLink(req: Request, env: Env, token: string): string {
  const base = gatewayBase(req, env);
  const page = req.headers.get("origin");
  const app = page && page !== base && isInstanceOrigin(page, env) ? `&app=${encodeURIComponent(page)}` : "";
  return `${base}/auth/email/verify?token=${token}${app}`;
}

/**
 * POST /auth/email/start {email, callsign?, purpose?} — begin email register (needs callsign) or login. With
 * `purpose: "account-data"` it mails a link that opens only the data of an account holding no call
 * ({@link ACCOUNT_DATA_PURPOSE}).
 */
export async function handleEmailStart(req: Request, env: Env): Promise<Response> {
  const {
    email,
    callsign,
    purpose: asked,
  } = (await req.json().catch(() => ({}))) as { email?: string; callsign?: string; purpose?: unknown };
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
  if (asked === ACCOUNT_DATA_PURPOSE) return startAccountData(req, env, e, acct);
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

  // The link opens this gateway's confirm page on the address the sign-in started on (origins.ts), so a member
  // who asked on the HAMNET address confirms there too.
  const link = verifyLink(req, env, token);
  const sent = await sendEmail(
    env,
    e,
    "Your APRScaching sign-in link",
    `Sign in to APRScaching:\n${link}\n\nThis link expires in 15 minutes. If you didn't request it, ignore this email.`,
  );
  return linkSent(env, e, purpose, token, link, sent);
}

/** The answer to a start once its mail went out, or the in-band link of an instance that opts into dev tokens. */
function linkSent(env: Env, e: string, purpose: string, token: string, link: string, sent: boolean): Response {
  if (sent) return json({ sent: true, purpose });
  // The sign-in token must NOT be handed back to the caller on a real instance. Returning
  // it in-band is a dev/CI convenience that is account-takeover in production — gate it behind an
  // explicit opt-in, never merely "email isn't configured". Off ⇒ fail closed.
  if (env.ALLOW_DEV_TOKENS === "1" || env.ALLOW_DEV_TOKENS === "true") {
    console.log("dev sign-in link for %s: %s", e, link); // the server log stands in for the mailbox
    return json({ sent: false, purpose, devToken: token, devLink: link });
  }
  return json({ error: "email delivery is not configured on this instance" }, { status: 503 });
}

/**
 * Mail the link that opens an account's data: only to the confirmed address of an account that holds no call, or of
 * a suspended account, which signs in nowhere else. Any other account with a call signs in as usual and finds export
 * and erasure in Settings.
 */
async function startAccountData(
  req: Request,
  env: Env,
  e: string,
  acct: { account_id: string; callsign: string } | null,
): Promise<Response> {
  if (!acct) return json({ error: "no account uses this email address" }, { status: 404 });
  if (!isFormerMarker(acct.callsign) && !(await suspensionOf(env, acct.account_id)))
    return json(
      {
        error: "your account holds a callsign — sign in with it, then get or erase your data in Settings",
        reason: "has_callsign",
      },
      { status: 409 },
    );
  const token = newToken();
  await env.DB.prepare(
    "INSERT INTO email_tokens (token, email, callsign, purpose, created_at, used) VALUES (?, ?, NULL, ?, ?, 0)",
  )
    .bind(token, e, ACCOUNT_DATA_PURPOSE, nowS())
    .run();
  const link = verifyLink(req, env, token);
  const sent = await sendEmail(
    env,
    e,
    "Your APRScaching data",
    `Open your APRScaching account's data to download a copy or erase it:\n${link}\n\n` +
      "The link opens your data and nothing else, and expires in 15 minutes. If you didn't request it, ignore this email.",
  );
  return linkSent(env, e, ACCOUNT_DATA_PURPOSE, token, link, sent);
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
 * `base` picks the origin the link names: APP_URL, an EXTRA_ORIGINS address (a member on HAMNET opens the
 * HAMNET one), or the station's hotspot origin (visitor.ts), the only one a visitor's phone can open. Any other
 * value is refused, so the link never points anywhere else.
 */
export async function handleOperatorLink(req: Request, env: Env): Promise<Response> {
  if (!operatorSecretOk(req, env)) return new Response("unauthorized", { status: 401 });
  if (!sessionsEnabled(env)) return sessionUnavailable();
  const body = (await req.json().catch(() => ({}))) as { callsign?: string; base?: unknown };
  const cs = String(body.callsign ?? "")
    .toUpperCase()
    .trim();
  if (!isRegistrableCall(cs)) return json({ error: "a valid, unreserved callsign is required" }, { status: 400 });
  const requested =
    body.base === undefined
      ? null
      : typeof body.base === "string"
        ? linkOrigin(body.base, env, instanceOrigins(env))
        : null;
  if (body.base !== undefined && requested === null)
    return json(
      {
        error:
          "base must be APP_URL, an EXTRA_ORIGINS address, or this station's https hotspot origin (a private IPv4 address on HTTPS_PORT)",
      },
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
  // names the app origin. Reached on another address of this instance, it names that address.
  const onLoopback = LOOPBACK_HOSTS.has(new URL(req.url).hostname);
  const origin = requested ?? (onLoopback && env.APP_URL ? appBase(env) : gatewayBase(req, env));
  console.log("operator sign-in link issued for %s (%s account)", cs, existing ? "existing" : "new");
  return json({
    link: `${origin}/auth/email/verify?token=${token}`,
    callsign: cs,
    account: existing ? "existing" : "new",
    expiresIn: TTL_SEC,
  });
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

/** What a link's confirm can end in, short of a session: the API's JSON error, and the page a browser sees. */
type LinkProblemKind =
  "invalid" | "expired" | "suspended" | "callsign" | "address" | "data" | "cross-site" | "unavailable";
interface LinkProblem {
  status: number;
  error: string;
  kind: LinkProblemKind;
  suspended?: { reason: string; until: number | null };
}
const problem = (status: number, kind: LinkProblemKind, error: string): LinkProblem => ({ status, kind, error });
const expired = (): LinkProblem => problem(400, "expired", "invalid or expired link");
const suspendedProblem = (e: AccountSuspended): LinkProblem => ({
  status: 403,
  kind: "suspended",
  error: e.message,
  suspended: e.suspension,
});
const isProblem = (x: Acct | LinkProblem): x is LinkProblem => "kind" in x;

/** A day in words, for a page: "12 October 2026". */
const dayText = (unixS: number) =>
  new Date(unixS * 1000).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
/** An API error message as a sentence on a page. */
const sentence = (s: string) => s.charAt(0).toUpperCase() + s.slice(1) + (/[.!?]$/.test(s) ? "" : ".");

/** What each kind of link does, for its confirm page; a sign-in or an operator link is the default. */
const CONFIRM_COPY: Record<string, { title: string; body: string; button: string }> = {
  [CONFIRM_PURPOSE]: {
    title: "Confirm your email address",
    body: "Confirm this address for your APRScaching account. Once confirmed, it signs you in and recovers the account.",
    button: "Confirm address",
  },
  [ACCOUNT_DATA_PURPOSE]: {
    title: "Open your data",
    body: "This link opens your account's data to download a copy or erase it, and nothing else.",
    button: "Open my data",
  },
};
const SIGN_IN_COPY = {
  title: "Sign in to APRScaching",
  body: "Confirm that you want to sign in on this device.",
  button: "Sign in",
};

/** The page a browser sees for a link that ends in `p`; `app` is the app's address, where its links lead. */
function problemPage(p: LinkProblem, app: string): Response {
  const back = { kind: "link" as const, label: "Back to APRScaching", href: `${app}/` };
  const again = { kind: "link" as const, label: "Request a new link", href: `${app}/?view=signin` };
  const page = (title: string, body: string[], action: typeof back, note?: string) =>
    linkPageResponse({ title, body, action, note, alert: true }, p.status);
  switch (p.kind) {
    case "invalid":
    case "expired":
      return page(
        "This link has expired",
        ["This link has expired or was already used — request a new one."],
        again,
        "A sign-in link works once, within 15 minutes; an address confirmation within 24 hours.",
      );
    case "suspended": {
      const s = p.suspended;
      const until = s?.until ? `until ${dayText(s.until)}` : "until the sysop lifts it";
      return page(
        "Account suspended",
        [sentence(`This account is suspended ${until}: ${s?.reason ?? "no reason given"}`)],
        back,
        "While the suspension holds, the account cannot sign in on this instance.",
      );
    }
    case "callsign":
      return page(
        "This callsign cannot sign in",
        [sentence(p.error)],
        again,
        "Request a new link with the callsign you operate.",
      );
    case "address":
      return page("This address was not confirmed", [sentence(p.error)], back);
    case "data":
      return page("This link no longer applies", [sentence(p.error)], again);
    case "cross-site":
      return page(
        "Sign-in refused",
        ["The confirmation came from another site, so nobody was signed in. Open the link from your email again."],
        back,
      );
    case "unavailable":
      return page("Sign-in is not available", ["This instance cannot open sessions. Tell its sysop."], back);
  }
}

/** The answer to a confirm that ends in `p`: a page for a browser, the JSON error for an API client. */
function answerProblem(p: LinkProblem, asPage: boolean, app: string): Response {
  if (asPage) return problemPage(p, app);
  return json({ error: p.error, ...(p.suspended ? { suspended: p.suspended } : {}) }, { status: p.status });
}

/** The app address a link's pages lead back to: the page's `app` when it is an address of this instance. */
function appFor(req: Request, env: Env, app: string | null | undefined): string {
  return app && isInstanceOrigin(app, env) ? app : requestOrigin(req, env);
}

type TokenRow = { email: string; callsign: string | null; purpose: string; created_at: number; used: number };
/** The token's row while it is usable: unspent and within its purpose's lifetime. */
async function liveToken(env: Env, token: string): Promise<TokenRow | null> {
  const row = await env.DB.prepare(
    "SELECT email, callsign, purpose, created_at, used FROM email_tokens WHERE token = ?",
  )
    .bind(token)
    .first<TokenRow>();
  const ttl = row?.purpose === CONFIRM_PURPOSE ? CONFIRM_TTL_SEC : TTL_SEC;
  return row && !row.used && nowS() - row.created_at <= ttl ? row : null;
}

/**
 * GET /auth/email/verify?token= — the link target: a confirm page for a browser, `{ confirm: true }` for
 * an API client. Never consumes the token; a browser opening a spent or expired link learns so at once.
 * POST /auth/email/verify {token} (JSON or a form) — consume the token and open a session. The confirm form
 * returns to the app on success and shows a page for every other outcome; an API client gets JSON.
 */
export async function handleEmailVerify(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  if (req.method === "GET") {
    const asPage = wantsPage(req);
    // `app` reaches the page only when it is an address of this instance
    const asked = url.searchParams.get("app");
    const app = asked && isInstanceOrigin(asked, env) ? asked : null;
    const token = url.searchParams.get("token");
    // only a well-formed token ever reaches the HTML page, so nothing a link carries is reflected into it
    if (!token || !TOKEN_SHAPE.test(token))
      return answerProblem(
        problem(400, "invalid", token ? "invalid token" : "missing token"),
        asPage,
        appFor(req, env, app),
      );
    if (!asPage) return json({ confirm: true, method: "POST", path: "/auth/email/verify" });
    const row = await liveToken(env, token);
    if (!row) return problemPage(expired(), appFor(req, env, app));
    const copy = CONFIRM_COPY[row.purpose] ?? SIGN_IN_COPY;
    return linkPageResponse({
      title: copy.title,
      body: [copy.body],
      action: { kind: "form", label: copy.button, fields: { token, ...(app ? { app } : {}) } },
      note: "Didn't request this? Close this page — nothing happens until you confirm.",
    });
  }

  const isForm = (req.headers.get("content-type") ?? "").includes("application/x-www-form-urlencoded");
  const asPage = isForm || wantsPage(req);
  if (!sameSiteOrigin(req, env))
    return answerProblem(problem(403, "cross-site", "cross-site sign-in refused"), asPage, requestOrigin(req, env));
  const form = isForm ? new URLSearchParams(await req.text().catch(() => "")) : null;
  const app = appFor(req, env, form?.get("app"));
  const token = form ? form.get("token") : (((await req.json().catch(() => ({}))) as { token?: string }).token ?? null);
  if (!token) return answerProblem(problem(400, "invalid", "missing token"), asPage, app);
  if (!sessionsEnabled(env))
    return asPage ? problemPage(problem(503, "unavailable", "sessions are disabled"), app) : sessionUnavailable();

  const row = await liveToken(env, token);
  if (!row) return answerProblem(expired(), asPage, app);
  // spend the token atomically: of two concurrent confirms only one sees the row still unused
  const spent = await env.DB.prepare("UPDATE email_tokens SET used = 1 WHERE token = ? AND used = 0").bind(token).run();
  if (spent.meta?.changes === 0) return answerProblem(expired(), asPage, app);

  const now = nowS();
  const dataOnly = row.purpose === ACCOUNT_DATA_PURPOSE;
  const acct =
    row.purpose === OPERATOR_PURPOSE
      ? await operatorLinkAccount(env, row.callsign ?? "", now)
      : row.purpose === CONFIRM_PURPOSE
        ? await confirmedAccount(env, row.email, row.callsign ?? "")
        : dataOnly
          ? await accountDataAccount(env, row.email)
          : await emailAccount(env, row.email, row.callsign, now);
  if (isProblem(acct)) return answerProblem(acct, asPage, app);

  let cookie: string;
  try {
    cookie = await issueSessionCookie(req, env, acct.account_id, acct.callsign, dataOnly ? "data" : "full");
  } catch (e) {
    if (e instanceof AccountSuspended) return answerProblem(suspendedProblem(e), asPage, app);
    throw e;
  }
  // the confirm form → back into the app with the session set; an API client → JSON. The app is on the
  // address the confirm came on (a visitor on the station's hotspot origin returns there, not to the owner's
  // localhost), or on the address of this instance the sign-in started on.
  if (form) return new Response(null, { status: 303, headers: { "set-cookie": cookie, location: app + "/" } });
  if (dataOnly) return json({ ok: true, callsign: null, accountData: true }, { headers: { "set-cookie": cookie } });
  return json(
    { ok: true, callsign: acct.callsign, licence: await licenceFor(env, acct.callsign) },
    { headers: { "set-cookie": cookie } },
  );
}

type Acct = { account_id: string; callsign: string };

/** The account a data link opens: the mailbox's account, while it holds no call or is suspended. */
async function accountDataAccount(env: Env, email: string): Promise<Acct | LinkProblem> {
  const acct = await env.DB.prepare("SELECT account_id, callsign FROM accounts WHERE email = ?")
    .bind(email)
    .first<Acct>();
  if (!acct || (!isFormerMarker(acct.callsign) && !(await suspensionOf(env, acct.account_id))))
    return problem(409, "data", "this link no longer applies — sign in with your callsign instead");
  return acct;
}

/** The account an email link signs in: the mailbox's account, or a new one registered under its call. */
async function emailAccount(
  env: Env,
  email: string,
  callsign: string | null,
  now: number,
): Promise<Acct | LinkProblem> {
  const acct = await env.DB.prepare("SELECT account_id, callsign FROM accounts WHERE email = ?")
    .bind(email)
    .first<Acct>();
  if (!acct) return createAccount(env, (callsign ?? "").toUpperCase(), email, now);
  if (!isFormerMarker(acct.callsign)) return acct;
  // a suspended account takes no call on: the sign-in is refused before anything is written
  const suspended = await suspensionOf(env, acct.account_id);
  if (suspended) return suspendedProblem(new AccountSuspended(suspended));
  // the account holds no call: it takes on the call the link was asked for, and its content follows
  const cs = (callsign ?? "").toUpperCase();
  const refused = cs.length >= 3 ? await unclaimableReason(env, cs) : "missing callsign";
  if (refused) return problem(409, "callsign", refused);
  try {
    await env.DB.batch(reclaimStatements(env, acct.account_id, acct.callsign, cs, now));
  } catch {
    return problem(409, "callsign", "callsign already claimed");
  }
  return { account_id: acct.account_id, callsign: cs };
}

/**
 * The account a confirmation link binds its address to: the holder of the call the address was given for,
 * while that address is still the one it waits for. The address then becomes the account's sign-in and
 * recovery email; an address already confirmed on another account stays there.
 */
async function confirmedAccount(env: Env, email: string, callsign: string): Promise<Acct | LinkProblem> {
  const holder = await baseHolder(env, baseCall(callsign));
  const acct = holder
    ? await env.DB.prepare("SELECT account_id, callsign, pending_email FROM accounts WHERE account_id = ?")
        .bind(holder)
        .first<Acct & { pending_email: string | null }>()
    : null;
  if (!acct || acct.pending_email !== email)
    return problem(400, "address", "this address is no longer waiting for confirmation");
  try {
    await env.DB.prepare(
      "UPDATE accounts SET email = ?, pending_email = NULL WHERE account_id = ? AND pending_email = ?",
    )
      .bind(email, acct.account_id, email)
      .run();
  } catch {
    return problem(409, "address", "that address already belongs to another account");
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
  const link = verifyLink(req, env, token);
  const sent = await sendEmail(
    env,
    email,
    "Confirm your APRScaching email address",
    `Confirm this address for the APRScaching account of ${callsign}:\n${link}\n\nOnce confirmed, it signs you in and recovers the account. The link expires in 24 hours. If you did not create this account, ignore this email: the address is not used until it is confirmed.`,
  );
  if (sent) return { sent };
  if (env.ALLOW_DEV_TOKENS === "1" || env.ALLOW_DEV_TOKENS === "true") {
    console.log("dev confirmation link for %s: %s", email, link);
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
async function operatorLinkAccount(env: Env, callsign: string, now: number): Promise<Acct | LinkProblem> {
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
): Promise<Acct | LinkProblem> {
  if (cs.length < 3) return problem(400, "callsign", "missing callsign for registration");
  // guard the race: the call (or its base, via another SSID) may have been claimed since the link was issued
  const refused = await unclaimableReason(env, cs, o);
  if (refused) return problem(409, "callsign", refused);
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
    return problem(409, "callsign", "callsign already claimed");
  }
  return { account_id: id, callsign: cs };
}
