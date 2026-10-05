// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * notify.ts — push + email-digest delivery over the watch alerts. Every instance with mail offers the email
 * digest, the fallback for devices without push (iOS, no PWA); both start off for a new account. In-app alerts
 * remain the always-on baseline.
 *
 *   GET  /api/push/key          VAPID public key (null when push isn't configured)
 *   POST /api/push/subscribe    store a Web Push subscription { endpoint, keys{p256dh,auth}, topics }
 *   POST /api/push/unsubscribe  remove { endpoint }
 *   GET/POST /api/notify/prefs  read / set the email digest (off until the user turns it on)
 *   GET/POST /api/notify/unsubscribe  the digest's signed one-click unsubscribe (confirm page, then POST)
 *
 * A push carries no payload: it is the VAPID-signed wake-up alone, and the service worker fetches the alert
 * text from the app. Push is config-gated (off unless VAPID_* set) and strictly best-effort. Each digest
 * mail links the instance and a signed unsubscribe link, and carries `List-Unsubscribe` headers for it.
 */
import { b64urlToBytes, bytesToB64url } from "./util/b64.js";
import { escapeHtml } from "./util/html.js";
import { nowS } from "./util/time.js";
import { instanceHost, type Env } from "./env.js";
import { json } from "./app.js";
import { setting } from "./siteconfig.js";
import { sendEmail } from "./mail.js";
import { purposeMac, sessionIdentity, timingSafeEqual } from "./auth.js";
import { appBase } from "./sitemap.js";

// ---- digest (pure, testable) ----
interface DigestAlert {
  callsign: string;
  kind: string;
  detail?: string | null;
  ts: number;
}

/** What an alert is about, by kind: [one, several]. A kind not named here counts as a plain alert. */
function topicOf(kind: string): [string, string] {
  if (kind === "heard" || kind === "near_cache") return ["watched station heard", "watched stations heard"];
  if (kind === "cache_found") return ["find of your cache", "finds of your caches"];
  if (kind === "corroborated") return ["find your station corroborated", "finds your station corroborated"];
  if (kind === "cache_dnf" || kind === "cache_maintenance") return ["report on your cache", "reports on your caches"];
  if (kind.startsWith("adoption_")) return ["cache adoption update", "cache adoption updates"];
  return ["other alert", "other alerts"];
}
const SUBJECT_MAX = 100;
const lineOf = (a: DigestAlert): string => a.detail || `${a.callsign} ${a.kind}`;

/** The subject names what the alerts are about: the one alert itself, else a count per topic. */
export function digestSubject(alerts: DigestAlert[]): string {
  if (alerts.length === 1) {
    const one = lineOf(alerts[0]!);
    return `aprscaching: ${one.length > SUBJECT_MAX ? one.slice(0, SUBJECT_MAX - 1) + "…" : one}`;
  }
  const counts = new Map<string, { t: [string, string]; n: number }>();
  for (const a of alerts) {
    const t = topicOf(a.kind);
    const c = counts.get(t[0]) ?? { t, n: 0 };
    c.n++;
    counts.set(t[0], c);
  }
  const parts = [...counts.values()].sort((x, y) => y.n - x.n).map(({ t, n }) => `${n} ${n === 1 ? t[0] : t[1]}`);
  return `aprscaching: ${parts.join(", ")}`;
}

/**
 * The digest mail. `appUrl` is the instance the reader opens; `unsubscribeUrl` (absent when the instance cannot
 * sign one) turns the digest off after one confirm.
 */
export function composeDigest(
  alerts: DigestAlert[],
  appUrl: string,
  unsubscribeUrl?: string | null,
): { subject: string; text: string } {
  const n = alerts.length;
  const lines = alerts.map((a) => `• ${lineOf(a)}`);
  const settings = "turn off Email digest under Settings → Notifications";
  const off = unsubscribeUrl
    ? `To stop this digest, open ${unsubscribeUrl} and confirm, or ${settings}.`
    : `To stop this digest, ${settings}.`;
  const text =
    `${n} new alert${n === 1 ? "" : "s"} on aprscaching:\n\n${lines.join("\n")}\n\n` +
    `See them on the map: ${appUrl}/\n\n-- \n${off}\n`;
  return { subject: digestSubject(alerts), text };
}

// ---- one-click unsubscribe (RFC 8058) ----
const UNSUB_PURPOSE = "digest-unsubscribe";
const UNSUB_PATH = "/api/notify/unsubscribe";
const UNSUB_TOKEN = /^([0-9A-Za-z-]{1,64})\.([0-9A-Za-z_-]{43})$/;

/** The account's unsubscribe link, or null when the instance has no session secret to sign it with. */
export async function unsubscribeUrl(env: Env, accountId: string): Promise<string | null> {
  const mac = await purposeMac(env, UNSUB_PURPOSE, accountId);
  return mac ? `${appBase(env)}${UNSUB_PATH}?token=${encodeURIComponent(`${accountId}.${mac}`)}` : null;
}

/** The account a well-formed, correctly signed unsubscribe token names, or null. */
async function unsubscribeAccount(env: Env, token: string | null): Promise<string | null> {
  const m = UNSUB_TOKEN.exec(token ?? "");
  if (!m) return null;
  const mac = await purposeMac(env, UNSUB_PURPOSE, m[1]!);
  return mac && timingSafeEqual(mac, m[2]!) ? m[1]! : null;
}

function unsubscribePage(title: string, body: string, status = 200): Response {
  return new Response(
    `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">
<meta name=referrer content=no-referrer>
<title>${escapeHtml(title)} · aprscaching</title><style>
:root{color-scheme:dark light}body{font:15px/1.5 system-ui,sans-serif;max-width:30rem;margin:3rem auto;padding:0 1rem}
h1{font-size:1.4rem}.m{opacity:.7}button{font:inherit;font-weight:600;min-height:44px;padding:.6rem 1.2rem;border-radius:10px}
button:focus-visible{outline:2px solid currentColor;outline-offset:2px}</style>
<h1>${escapeHtml(title)}</h1>
${body}`,
    {
      status,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
      },
    },
  );
}

/**
 * GET /api/notify/unsubscribe?token= — the digest's unsubscribe link: a confirm page, which changes nothing, so
 * a mail scanner that follows links unsubscribes nobody.
 * POST /api/notify/unsubscribe?token= — turns the digest off. A mail client's one-click unsubscribe (RFC 8058,
 * body `List-Unsubscribe=One-Click`) and the confirm page's button both land here. The signed token is the
 * credential, so no session and no origin check is needed.
 */
export async function handleNotifyUnsubscribe(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  let token = url.searchParams.get("token");
  if (req.method === "POST" && !token) {
    const ct = req.headers.get("content-type") ?? "";
    if (ct.includes("application/x-www-form-urlencoded"))
      token = new URLSearchParams(await req.text().catch(() => "")).get("token");
  }
  const acct = await unsubscribeAccount(env, token);
  const html = (req.headers.get("accept") ?? "").includes("text/html");
  if (!acct) {
    return html
      ? unsubscribePage(
          "Link not valid",
          "<p>This unsubscribe link is not valid. Turn the digest off under Settings → Notifications.</p>",
          400,
        )
      : json({ error: "invalid unsubscribe link" }, { status: 400 });
  }
  if (req.method === "GET") {
    if (!html) return json({ confirm: true, method: "POST", path: UNSUB_PATH });
    return unsubscribePage(
      "Stop the email digest",
      `<p>Confirm that you no longer want the alert digest by email. Alerts stay in the app.</p>
<form method="post" action="${UNSUB_PATH}?token=${escapeHtml(encodeURIComponent(token!))}"><button type="submit">Stop the digest</button></form>
<p class=m>Opened this by mistake? Close this page. Nothing changes until you confirm.</p>`,
    );
  }
  await env.DB.prepare("UPDATE accounts SET notify_digest = 0 WHERE account_id = ?").bind(acct).run();
  return html
    ? unsubscribePage(
        "Digest stopped",
        `<p>You get no more digest mails. Turn it back on under Settings → Notifications.</p><p><a href="${escapeHtml(appBase(env))}/">Open aprscaching</a></p>`,
      )
    : json({ ok: true, digest: false });
}

// ---- VAPID key + subscriptions ----
export function handlePushKey(_req: Request, env: Env): Response {
  return json({ key: env.VAPID_PUBLIC ?? null });
}
export async function handlePushSubscribe(req: Request, env: Env): Promise<Response> {
  const acct = (await sessionIdentity(req, env))?.accountId ?? null;
  if (!acct) return json({ error: "sign in" }, { status: 401 });
  const b = (await req.json().catch(() => ({}))) as {
    endpoint?: string;
    keys?: { p256dh?: string; auth?: string };
    topics?: string[];
  };
  if (!b.endpoint) return json({ error: "endpoint required" }, { status: 400 });
  await env.DB.prepare(
    "INSERT OR REPLACE INTO push_subs (account_id, endpoint, p256dh, auth, topics, created_at) VALUES (?,?,?,?,?,?)",
  )
    .bind(acct, b.endpoint, b.keys?.p256dh ?? null, b.keys?.auth ?? null, (b.topics ?? ["watch"]).join(","), nowS())
    .run();
  return json({ ok: true }, { status: 201 });
}
export async function handlePushUnsubscribe(req: Request, env: Env): Promise<Response> {
  const acct = (await sessionIdentity(req, env))?.accountId ?? null;
  if (!acct) return json({ error: "sign in" }, { status: 401 });
  const b = (await req.json().catch(() => ({}))) as { endpoint?: string };
  await env.DB.prepare("DELETE FROM push_subs WHERE account_id = ? AND endpoint = ?")
    .bind(acct, b.endpoint ?? "")
    .run();
  return json({ ok: true });
}

// ---- email-digest preference ----
export async function handleNotifyPrefs(req: Request, env: Env): Promise<Response> {
  const acct = (await sessionIdentity(req, env))?.accountId ?? null;
  if (!acct) return json({ error: "sign in" }, { status: 401 });
  if (req.method === "POST") {
    const b = (await req.json().catch(() => ({}))) as { digest?: boolean };
    await env.DB.prepare("UPDATE accounts SET notify_digest = ? WHERE account_id = ?")
      .bind(b.digest === true ? 1 : 0, acct)
      .run();
  }
  const r = await env.DB.prepare("SELECT notify_digest AS digest, email FROM accounts WHERE account_id = ?")
    .bind(acct)
    .first<{ digest: number; email: string | null }>();
  return json({ digest: (r?.digest ?? 0) === 1, hasEmail: !!r?.email, pushConfigured: !!env.VAPID_PUBLIC });
}

/** Scheduled: email each account its un-notified watch alerts, then mark them sent. */
export async function runDigests(env: Env): Promise<void> {
  const accts = (
    await env.DB.prepare(
      `SELECT DISTINCT wa.account_id AS acct, a.email AS email FROM watch_alerts wa
       JOIN accounts a ON a.account_id = wa.account_id
      WHERE wa.notified = 0 AND a.email IS NOT NULL AND a.notify_digest = 1`,
    ).all<{ acct: string; email: string }>()
  ).results;
  for (const r of accts) {
    const alerts = (
      await env.DB.prepare(
        "SELECT id, callsign, kind, detail, ts FROM watch_alerts WHERE account_id = ? AND notified = 0 ORDER BY ts DESC LIMIT 50",
      )
        .bind(r.acct)
        .all<DigestAlert>()
    ).results;
    if (!alerts.length) continue;
    const unsub = await unsubscribeUrl(env, r.acct);
    const { subject, text } = composeDigest(alerts, appBase(env), unsub);
    const headers = unsub
      ? { "List-Unsubscribe": `<${unsub}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" }
      : undefined;
    const sent = await sendEmail(env, r.email, subject, text, headers);
    await env.DB.prepare("UPDATE watch_alerts SET notified = 1 WHERE account_id = ? AND notified = 0")
      .bind(r.acct)
      .run();
    if (!sent) console.log(`digest (no email provider): ${alerts.length} alerts for ${r.acct}`);
  }
}

// ---- web push (VAPID); config-gated + best-effort ----
// We send a PAYLOAD-LESS push (just the VAPID auth): valid Web Push that wakes the service worker,
// which renders a generic "watchlist alert" and can pull the detail from /api/watch/alerts. This
// avoids the RFC-8291 aes128gcm payload encryption entirely — the specific text already lives in the
// in-app feed and the email digest.
export async function pushAlert(env: Env, accountId: string): Promise<void> {
  if (!env.VAPID_PUBLIC || !env.VAPID_PRIVATE) return; // disabled unless configured
  const subs = (
    await env.DB.prepare("SELECT endpoint FROM push_subs WHERE account_id = ?")
      .bind(accountId)
      .all<{ endpoint: string }>()
  ).results;
  for (const s of subs) {
    try {
      await webPush(env, s.endpoint);
    } catch {
      /* best-effort */
    }
  }
}

/**
 * The VAPID `sub` contact (RFC 8292): VAPID_SUBJECT, else the operator's address, else the instance's own
 * https origin. Without any of them the claim is left out, which RFC 8292 permits.
 */
export function vapidSubject(env: Env): string | null {
  const set = env.VAPID_SUBJECT?.trim();
  if (set) return set;
  const email = setting(env, "OPERATOR_EMAIL")?.trim();
  if (email) return `mailto:${email}`;
  const host = instanceHost(env);
  return host ? `https://${host}` : null;
}

const vapidSubjectClaim = (env: Env): { sub?: string } => {
  const sub = vapidSubject(env);
  return sub ? { sub } : {};
};

/** VAPID ES256 JWT for the push service origin. */
async function vapidJwt(env: Env, aud: string): Promise<string> {
  const pub = b64urlToBytes(env.VAPID_PUBLIC!); // 65-byte uncompressed P-256 point
  const jwk: JsonWebKey = {
    kty: "EC",
    crv: "P-256",
    d: env.VAPID_PRIVATE,
    x: bytesToB64url(pub.slice(1, 33)),
    y: bytesToB64url(pub.slice(33, 65)),
    ext: true,
  };
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const header = bytesToB64url(new TextEncoder().encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const body = bytesToB64url(
    new TextEncoder().encode(JSON.stringify({ aud, exp: nowS() + 12 * 3600, ...vapidSubjectClaim(env) })),
  );
  const sig = new Uint8Array(
    await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, new TextEncoder().encode(`${header}.${body}`)),
  );
  return `${header}.${body}.${bytesToB64url(sig)}`;
}

async function webPush(env: Env, endpoint: string): Promise<void> {
  await fetch(endpoint, {
    method: "POST",
    headers: {
      TTL: "86400",
      Authorization: `vapid t=${await vapidJwt(env, new URL(endpoint).origin)}, k=${env.VAPID_PUBLIC}`,
    },
  });
}
