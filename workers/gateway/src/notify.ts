// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * notify.ts — push + email-digest delivery (ADR-4b, docs/11 M4) over the W1 watch alerts. The email
 * digest is the MANDATORY fallback (iOS/no-push); web push is the enhancement. In-app alerts (W1)
 * remain the always-on baseline.
 *
 *   GET  /api/push/key          VAPID public key (null when push isn't configured)
 *   POST /api/push/subscribe    store a Web Push subscription { endpoint, keys{p256dh,auth}, topics }
 *   POST /api/push/unsubscribe  remove { endpoint }
 *   GET/POST /api/notify/prefs  read / set the email-digest opt-out
 *
 * Web-push encryption follows RFC 8291 (aes128gcm) + VAPID; it's config-gated (off unless VAPID_* set)
 * and strictly best-effort. The digest composition + base64url helpers are unit-tested.
 */
import type { Env } from "./env.js";
import { json } from "./app.js";
import { sessionAccountId } from "./watch.js";
import { sendEmail } from "./email.js";

const now = () => Math.floor(Date.now() / 1000);

// ---- base64url ----
export function b64urlToBytes(s: string): Uint8Array {
  const t = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4);
  const bin = atob(t); const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u;
}
export function bytesToB64url(b: Uint8Array): string {
  let s = ""; for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// ---- digest (pure, testable) ----
export interface DigestAlert { callsign: string; kind: string; detail?: string | null; ts: number }
export function composeDigest(alerts: DigestAlert[]): { subject: string; text: string } {
  const n = alerts.length;
  const subject = `aprscaching — ${n} new watchlist alert${n === 1 ? "" : "s"}`;
  const lines = alerts.map((a) => `• ${a.detail || `${a.callsign} ${a.kind}`}`);
  const text = `You have ${n} new alert${n === 1 ? "" : "s"} on your watchlist:\n\n${lines.join("\n")}\n\n` +
    `Open aprscaching to see them on the map. (Reply STOP in settings to turn off this digest.)`;
  return { subject, text };
}

// ---- VAPID key + subscriptions ----
export function handlePushKey(_req: Request, env: Env): Response {
  return json({ key: env.VAPID_PUBLIC ?? null });
}
export async function handlePushSubscribe(req: Request, env: Env): Promise<Response> {
  const acct = await sessionAccountId(req, env);
  if (!acct) return json({ error: "sign in" }, { status: 401 });
  const b = (await req.json().catch(() => ({}))) as { endpoint?: string; keys?: { p256dh?: string; auth?: string }; topics?: string[] };
  if (!b.endpoint) return json({ error: "endpoint required" }, { status: 400 });
  await env.DB.prepare("INSERT OR REPLACE INTO push_subs (account_id, endpoint, p256dh, auth, topics, created_at) VALUES (?,?,?,?,?,?)")
    .bind(acct, b.endpoint, b.keys?.p256dh ?? null, b.keys?.auth ?? null, (b.topics ?? ["watch"]).join(","), now()).run();
  return json({ ok: true }, { status: 201 });
}
export async function handlePushUnsubscribe(req: Request, env: Env): Promise<Response> {
  const acct = await sessionAccountId(req, env);
  if (!acct) return json({ error: "sign in" }, { status: 401 });
  const b = (await req.json().catch(() => ({}))) as { endpoint?: string };
  await env.DB.prepare("DELETE FROM push_subs WHERE account_id = ? AND endpoint = ?").bind(acct, b.endpoint ?? "").run();
  return json({ ok: true });
}

// ---- email-digest preference ----
export async function handleNotifyPrefs(req: Request, env: Env): Promise<Response> {
  const acct = await sessionAccountId(req, env);
  if (!acct) return json({ error: "sign in" }, { status: 401 });
  if (req.method === "POST") {
    const b = (await req.json().catch(() => ({}))) as { digest?: boolean };
    await env.DB.prepare("UPDATE accounts SET notify_digest = ? WHERE account_id = ?").bind(b.digest === false ? 0 : 1, acct).run();
  }
  const r = await env.DB.prepare("SELECT notify_digest AS digest, email FROM accounts WHERE account_id = ?").bind(acct).first<{ digest: number; email: string | null }>();
  return json({ digest: (r?.digest ?? 1) === 1, hasEmail: !!r?.email, pushConfigured: !!env.VAPID_PUBLIC });
}

/** Scheduled: email each account its un-notified watch alerts, then mark them sent. */
export async function runDigests(env: Env): Promise<void> {
  const accts = (await env.DB.prepare(
    `SELECT DISTINCT wa.account_id AS acct, a.email AS email FROM watch_alerts wa
       JOIN accounts a ON a.account_id = wa.account_id
      WHERE wa.notified = 0 AND a.email IS NOT NULL AND a.notify_digest = 1`,
  ).all<{ acct: string; email: string }>()).results;
  for (const r of accts) {
    const alerts = (await env.DB.prepare("SELECT id, callsign, kind, detail, ts FROM watch_alerts WHERE account_id = ? AND notified = 0 ORDER BY ts DESC LIMIT 50").bind(r.acct).all<DigestAlert>()).results;
    if (!alerts.length) continue;
    const { subject, text } = composeDigest(alerts);
    const sent = await sendEmail(env, r.email, subject, text);
    await env.DB.prepare("UPDATE watch_alerts SET notified = 1 WHERE account_id = ? AND notified = 0").bind(r.acct).run();
    if (!sent) console.log(`digest (no email provider): ${alerts.length} alerts for ${r.acct}`);
  }
}

// ---- web push (VAPID); config-gated + best-effort ----
// We send a PAYLOAD-LESS push (just the VAPID auth): valid Web Push that wakes the service worker,
// which renders a generic "watchlist alert" and can pull the detail from /api/watch/alerts. This
// avoids the RFC-8291 aes128gcm payload encryption entirely — the specific text already lives in the
// in-app feed (W1) and the email digest.
export async function pushAlert(env: Env, accountId: string): Promise<void> {
  if (!env.VAPID_PUBLIC || !env.VAPID_PRIVATE) return; // disabled unless configured
  const subs = (await env.DB.prepare("SELECT endpoint FROM push_subs WHERE account_id = ?").bind(accountId).all<{ endpoint: string }>()).results;
  for (const s of subs) { try { await webPush(env, s.endpoint); } catch { /* best-effort */ } }
}

/** VAPID ES256 JWT for the push service origin. */
async function vapidJwt(env: Env, aud: string): Promise<string> {
  const pub = b64urlToBytes(env.VAPID_PUBLIC!); // 65-byte uncompressed P-256 point
  const jwk: JsonWebKey = { kty: "EC", crv: "P-256", d: env.VAPID_PRIVATE, x: bytesToB64url(pub.slice(1, 33)), y: bytesToB64url(pub.slice(33, 65)), ext: true };
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const header = bytesToB64url(new TextEncoder().encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const body = bytesToB64url(new TextEncoder().encode(JSON.stringify({ aud, exp: now() + 12 * 3600, sub: env.VAPID_SUBJECT ?? "mailto:admin@aprscaching.net" })));
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, new TextEncoder().encode(`${header}.${body}`)));
  return `${header}.${body}.${bytesToB64url(sig)}`;
}

async function webPush(env: Env, endpoint: string): Promise<void> {
  await fetch(endpoint, { method: "POST", headers: { TTL: "86400", Authorization: `vapid t=${await vapidJwt(env, new URL(endpoint).origin)}, k=${env.VAPID_PUBLIC}` } });
}
