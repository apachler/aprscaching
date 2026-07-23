// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Env } from "./env.js";
import { json } from "./app.js";
import { issueSessionCookie } from "./auth.js";

/**
 * Email magic-link auth: the passwordless recovery / no-authenticator path that complements
 * passkeys. `start` issues a one-time token and emails a link; `verify` consumes it and opens a
 * session (creating the account on first register). When no email provider is configured (dev/CI),
 * `start` returns the token in-band so headless flows and first-run can proceed without real mail.
 */

const TTL_SEC = 15 * 60;
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

function newToken(): string {
  return (crypto.randomUUID() + crypto.randomUUID()).replace(/-/g, "");
}
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

  const acct = await env.DB.prepare("SELECT account_id FROM accounts WHERE email = ?").bind(e).first();
  const purpose = acct ? "login" : "register";
  let cs: string | null = null;
  if (purpose === "register") {
    cs = String(callsign ?? "")
      .toUpperCase()
      .trim();
    if (cs.length < 3) return json({ error: "callsign required to register" }, { status: 400 });
    const taken = await env.DB.prepare("SELECT 1 FROM accounts WHERE callsign = ?").bind(cs).first();
    if (taken) return json({ error: "callsign already claimed — sign in with its email" }, { status: 409 });
  }

  const token = newToken();
  await env.DB.prepare(
    "INSERT INTO email_tokens (token, email, callsign, purpose, created_at, used) VALUES (?, ?, ?, ?, ?, 0)",
  )
    .bind(token, e, cs, purpose, Math.floor(Date.now() / 1000))
    .run();

  const link = `${appOrigin(req, env)}/auth/email/verify?token=${token}`;
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
  if (env.ALLOW_DEV_TOKENS === "1" || env.ALLOW_DEV_TOKENS === "true")
    return json({ sent: false, purpose, devToken: token, devLink: link });
  return json({ error: "email delivery is not configured on this instance" }, { status: 503 });
}

/** GET|POST /auth/email/verify — consume the token, open a session (create account on register). */
export async function handleEmailVerify(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  let token = url.searchParams.get("token");
  if (!token && req.method === "POST")
    token = ((await req.json().catch(() => ({}))) as { token?: string }).token ?? null;
  if (!token) return json({ error: "missing token" }, { status: 400 });

  const row = await env.DB.prepare(
    "SELECT email, callsign, purpose, created_at, used FROM email_tokens WHERE token = ?",
  )
    .bind(token)
    .first<{ email: string; callsign: string | null; purpose: string; created_at: number; used: number }>();
  const now = Math.floor(Date.now() / 1000);
  if (!row || row.used || now - row.created_at > TTL_SEC) {
    return json({ error: "invalid or expired link" }, { status: 400 });
  }
  await env.DB.prepare("UPDATE email_tokens SET used = 1 WHERE token = ?").bind(token).run();

  let acct = await env.DB.prepare("SELECT account_id, callsign FROM accounts WHERE email = ?")
    .bind(row.email)
    .first<{ account_id: string; callsign: string }>();
  if (!acct) {
    // register: create the durable account + record the initial callsign (unverified control)
    const id = crypto.randomUUID();
    const cs = (row.callsign ?? "").toUpperCase();
    if (cs.length < 3) return json({ error: "missing callsign for registration" }, { status: 400 });
    // guard the race: callsign may have been claimed since `start`
    const taken = await env.DB.prepare("SELECT 1 FROM accounts WHERE callsign = ?").bind(cs).first();
    if (taken) return json({ error: "callsign already claimed" }, { status: 409 });
    await env.DB.prepare(
      "INSERT INTO accounts (callsign, account_id, email, verified, created_at) VALUES (?, ?, ?, 0, ?)",
    )
      .bind(cs, id, row.email, now)
      .run();
    await env.DB.prepare("INSERT INTO callsign_history (account_id, callsign, set_at, verified) VALUES (?, ?, ?, 0)")
      .bind(id, cs, now)
      .run();
    // seed the held-callsign set with this call as the account's primary base call
    await env.DB.prepare(
      "INSERT OR IGNORE INTO account_callsigns (account_id, callsign, verified, is_primary, added_at) VALUES (?, ?, 0, 1, ?)",
    )
      .bind(id, cs.split("-")[0], now)
      .run();
    acct = { account_id: id, callsign: cs };
  }

  const cookie = await issueSessionCookie(acct.callsign, env);
  // a real browser hitting the GET link → redirect into the app with the session set; API → JSON
  if (req.method === "GET" && (req.headers.get("accept") ?? "").includes("text/html")) {
    return new Response(null, { status: 302, headers: { "set-cookie": cookie, location: appOrigin(req, env) + "/" } });
  }
  return json({ ok: true, callsign: acct.callsign }, { headers: { "set-cookie": cookie } });
}

/** Pluggable sender. Resend-compatible JSON API; returns false (dev mode) when unconfigured. */
export async function sendEmail(env: Env, to: string, subject: string, text: string): Promise<boolean> {
  if (!env.EMAIL_API_KEY || !env.EMAIL_FROM) return false;
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${env.EMAIL_API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ from: env.EMAIL_FROM, to, subject, text }),
    });
    return res.ok;
  } catch {
    return false;
  }
}
