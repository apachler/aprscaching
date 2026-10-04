// SPDX-License-Identifier: AGPL-3.0-or-later
import { createTransport } from "nodemailer";
import type { Env } from "./env.js";
import { json } from "./app.js";
import { requireSysop } from "./admin.js";
import { normalEmail } from "./email.js";

/**
 * Outgoing mail: sign-in links, address confirmations and the watch digest. One rule picks the transport:
 * SMTP when `SMTP_HOST` is set, else the Resend HTTP API when `EMAIL_API_KEY` is set, else none. `EMAIL_FROM`
 * is the sender on both; without it the instance sends no mail. Every message is plain text.
 *
 * A send never throws and never holds a request for long: an SMTP server that does not answer is given up
 * after {@link SMTP_TIMEOUT_MS}. A failure is logged as one line that names the reason but carries no
 * credential, no message text and no address.
 */

/** The Resend send endpoint; the privacy page names its host when Resend carries the mail. */
const EMAIL_API_URL = "https://api.resend.com/emails";

/** How long an SMTP connect, greeting or idle socket may take before the send is given up. */
const SMTP_TIMEOUT_MS = 10_000;

/** `starttls` upgrades a plain connection and refuses a server that cannot; `tls` is TLS from the first
 *  byte (port 465); `none` sends in the clear, for a relay on the same box or a trusted LAN. */
type SmtpSecurity = "starttls" | "tls" | "none";

type MailTransport =
  { kind: "smtp"; host: string; port: number; security: SmtpSecurity } | { kind: "resend"; host: string };

/** The transport this instance sends mail over, or null when it sends none. */
export function mailTransport(env: Env): MailTransport | null {
  if (!env.EMAIL_FROM?.trim()) return null;
  const host = env.SMTP_HOST?.trim();
  if (host) {
    const port = Number(env.SMTP_PORT) || 587;
    const s = env.SMTP_SECURE;
    const security: SmtpSecurity =
      s === "starttls" || s === "tls" || s === "none" ? s : port === 465 ? "tls" : "starttls";
    return { kind: "smtp", host, port, security };
  }
  if (env.EMAIL_API_KEY) return { kind: "resend", host: new URL(EMAIL_API_URL).host };
  return null;
}

/** The transport in a few words, for the Setup checklist and the mail test. */
export function describeTransport(t: MailTransport): string {
  return t.kind === "smtp" ? `SMTP ${t.host}:${t.port} (${t.security})` : `the Resend API (${t.host})`;
}

type MailResult = { ok: true } | { ok: false; error: string };

/** Send one plain-text mail. Returns true once the transport accepted it; false when mail is off or it failed. */
export async function sendEmail(env: Env, to: string, subject: string, text: string): Promise<boolean> {
  return (await deliverMail(env, to, subject, text)).ok;
}

/**
 * Send one plain-text mail and say why it failed. `timeoutMs` bounds each SMTP phase. The reason is safe to
 * show the operator: it carries no credential and no address.
 */
export async function deliverMail(
  env: Env,
  to: string,
  subject: string,
  text: string,
  timeoutMs = SMTP_TIMEOUT_MS,
): Promise<MailResult> {
  const t = mailTransport(env);
  if (!t) return { ok: false, error: "no mail transport is configured (EMAIL_FROM with SMTP_HOST or EMAIL_API_KEY)" };
  const from = env.EMAIL_FROM!.trim();
  const result =
    t.kind === "smtp"
      ? await viaSmtp(env, t, from, to, subject, text, timeoutMs)
      : await viaResend(env, from, to, subject, text);
  if (!result.ok) console.warn(`mail: ${describeTransport(t)} did not take the message: ${result.error}`);
  return result;
}

async function viaResend(env: Env, from: string, to: string, subject: string, text: string): Promise<MailResult> {
  try {
    const res = await fetch(EMAIL_API_URL, {
      method: "POST",
      headers: { authorization: `Bearer ${env.EMAIL_API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ from, to, subject, text }),
      signal: AbortSignal.timeout(SMTP_TIMEOUT_MS),
    });
    return res.ok ? { ok: true } : { ok: false, error: `HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, error: reason(e) };
  }
}

/**
 * POST /api/admin/mail-test {to} — the sysop (or a script with the operator secret, tools/admin/mail-test.mjs)
 * sends one test mail and reads back the transport and, on failure, the server's reason.
 */
export async function handleMailTest(req: Request, env: Env): Promise<Response> {
  const guard = await requireSysop(req, env, { allowOperatorSecret: true });
  if (guard) return guard;
  const { to } = (await req.json().catch(() => ({}))) as { to?: unknown };
  const address = normalEmail(to);
  if (!address) return json({ error: "a valid address is required (to)" }, { status: 400 });
  const t = mailTransport(env);
  const over = t ? describeTransport(t) : null;
  const result = await deliverMail(
    env,
    address,
    "aprscaching test mail",
    `This is a test mail from the aprscaching instance at ${env.APP_URL ?? env.INSTANCE ?? "this host"}.\n\n` +
      `It went out over ${over}, the way sign-in links and the watch digest go.`,
  );
  return json({ transport: over, ...result }, { status: result.ok ? 200 : 502 });
}

type Mailer = ReturnType<typeof createTransport>;
/** One transporter per process, rebuilt only when its settings change. */
let mailer: { key: string; mailer: Mailer } | null = null;

function smtpMailer(env: Env, t: Extract<MailTransport, { kind: "smtp" }>, timeoutMs: number): Mailer {
  const user = env.SMTP_USER?.trim() || undefined;
  const pass = env.SMTP_PASS ?? "";
  const name = helloName(env);
  const key = JSON.stringify([t.host, t.port, t.security, user, pass, name, timeoutMs]);
  if (mailer?.key === key) return mailer.mailer;
  const m = createTransport({
    host: t.host,
    port: t.port,
    secure: t.security === "tls",
    requireTLS: t.security === "starttls",
    ignoreTLS: t.security === "none",
    auth: user ? { user, pass } : undefined,
    name,
    connectionTimeout: timeoutMs,
    greetingTimeout: timeoutMs,
    socketTimeout: timeoutMs,
    dnsTimeout: timeoutMs,
    logger: false,
  });
  mailer = { key, mailer: m };
  return m;
}

async function viaSmtp(
  env: Env,
  t: Extract<MailTransport, { kind: "smtp" }>,
  from: string,
  to: string,
  subject: string,
  text: string,
  timeoutMs: number,
): Promise<MailResult> {
  try {
    await smtpMailer(env, t, timeoutMs).sendMail({
      from,
      to,
      subject,
      text,
      date: new Date(),
      messageId: `<${crypto.randomUUID()}@${senderDomain(from)}>`,
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: reason(e) };
  }
}

/** The domain of the sender address, which names the Message-ID: `Name <a@b.example>` and `a@b.example` alike. */
function senderDomain(from: string): string {
  const open = from.lastIndexOf("<");
  const close = from.indexOf(">", open);
  const addr = open >= 0 && close > open ? from.slice(open + 1, close) : from;
  return addr.split("@").pop()?.trim() || "localhost";
}

/** The name the client greets the server with (EHLO): the instance's public host, else the system's own. */
function helloName(env: Env): string | undefined {
  try {
    return env.APP_URL ? new URL(env.APP_URL).hostname : undefined;
  } catch {
    return undefined;
  }
}

/** A failure as one line: the error code, the server's reply code, and its text with every address masked. */
function reason(e: unknown): string {
  const err = e as { code?: string; responseCode?: number; message?: string };
  // split on the characters around an address, so masking stays linear in the length of the text
  const text = String(err?.message ?? e)
    .split(/([\s<>"']+)/)
    .map((part) => (part.includes("@") ? "[address]" : /\s/.test(part) ? part.replace(/\s+/g, " ") : part))
    .join("")
    .trim();
  return [err?.code, err?.responseCode, text].filter((x) => x !== undefined && x !== "").join(" ");
}
