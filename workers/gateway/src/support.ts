// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * support.ts — supporter recognition + the public transparency ledger.
 *
 * RECOGNITION ONLY. A donation sets accounts.tier='supporter' purely for a badge + the ability to
 * hide the support prompt. NOTHING here gates a feature, and no core handler reads tier to restrict
 * anything — everyone gets everything for free.
 *
 *   GET  /support                  public HTML transparency page
 *   GET  /api/support              public JSON: donation links + ledger summary + opt-in supporters
 *   GET/POST /api/support/prefs     (session) read / set hide-nag (+ your supporter status)
 *   POST /api/support/confirm       (ingest secret) webhook/manual confirm → tier + a ledger entry
 */
import type { Env } from "./env.js";
import { json } from "./app.js";
import { sessionAccountId } from "./watch.js";

const now = () => Math.floor(Date.now() / 1000);
const BUCKETS = ["development", "hosting", "operation", "peer_reimbursement"] as const;
type Bucket = (typeof BUCKETS)[number];
const ingestOk = (req: Request, env: Env): boolean => (req.headers.get("x-ingest-secret") ?? "") === env.INGEST_SECRET;

export interface LedgerRow {
  ts: number;
  direction: string;
  bucket: string;
  amount_cents: number;
  currency?: string | null;
}

export interface LedgerSummary {
  currency: string;
  totalInCents: number;
  totalOutCents: number;
  balanceCents: number;
  buckets: Record<Bucket, { inCents: number; outCents: number }>;
  months: { month: string; inCents: number; outCents: number }[];
}

/** Summarize ledger rows into per-bucket totals + a monthly in/out series (pure / testable). */
export function summarizeLedger(rows: LedgerRow[]): LedgerSummary {
  const buckets = Object.fromEntries(BUCKETS.map((b) => [b, { inCents: 0, outCents: 0 }])) as LedgerSummary["buckets"];
  const months = new Map<string, { inCents: number; outCents: number }>();
  let totalInCents = 0,
    totalOutCents = 0,
    currency = "EUR";
  for (const r of rows) {
    if (r.currency) currency = r.currency;
    const m = new Date(r.ts * 1000).toISOString().slice(0, 7); // YYYY-MM (UTC)
    const mo = months.get(m) ?? { inCents: 0, outCents: 0 };
    const bk = (BUCKETS as readonly string[]).includes(r.bucket) ? buckets[r.bucket as Bucket] : null;
    if (r.direction === "in") {
      totalInCents += r.amount_cents;
      mo.inCents += r.amount_cents;
      if (bk) bk.inCents += r.amount_cents;
    } else {
      totalOutCents += r.amount_cents;
      mo.outCents += r.amount_cents;
      if (bk) bk.outCents += r.amount_cents;
    }
    months.set(m, mo);
  }
  return {
    currency,
    totalInCents,
    totalOutCents,
    balanceCents: totalInCents - totalOutCents,
    buckets,
    months: [...months.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([month, v]) => ({ month, ...v })),
  };
}

/** Donation links from env (only the configured ones are surfaced). */
function donationLinks(env: Env): { label: string; url: string }[] {
  const links: { label: string; url: string }[] = [];
  if (env.SUPPORT_LIBERAPAY) links.push({ label: "Liberapay", url: env.SUPPORT_LIBERAPAY });
  if (env.SUPPORT_KOFI) links.push({ label: "Ko-fi", url: env.SUPPORT_KOFI });
  if (env.SUPPORT_PATREON) links.push({ label: "Patreon", url: env.SUPPORT_PATREON });
  if (env.SUPPORT_GITHUB) links.push({ label: "GitHub Sponsors", url: env.SUPPORT_GITHUB });
  if (env.SUPPORT_OPENCOLLECTIVE) links.push({ label: "Open Collective", url: env.SUPPORT_OPENCOLLECTIVE });
  return links;
}

async function ledgerSummary(env: Env): Promise<LedgerSummary> {
  const rows = (
    await env.DB.prepare(
      "SELECT ts, direction, bucket, amount_cents, currency FROM ledger ORDER BY ts",
    ).all<LedgerRow>()
  ).results;
  return summarizeLedger(rows);
}

/** Opt-in public supporters: tier='supporter' AND a public profile. Recognition, not a directory. */
async function publicSupporters(env: Env): Promise<string[]> {
  return (
    await env.DB.prepare(
      "SELECT callsign FROM accounts WHERE tier='supporter' AND COALESCE(profile_public,1)=1 ORDER BY callsign",
    ).all<{ callsign: string }>()
  ).results.map((r) => r.callsign);
}

/** GET /api/support — public transparency JSON. */
export async function handleSupport(_req: Request, env: Env): Promise<Response> {
  const [ledger, supporters] = await Promise.all([ledgerSummary(env), publicSupporters(env)]);
  return json({
    model: "free-in-full · recognition-only · ad-free (donations gate nothing functional)",
    donationLinks: donationLinks(env),
    ledger,
    supporters,
    supporterCount: supporters.length,
  });
}

/** GET/POST /api/support/prefs — read or set the caller's hide-nag; also reports supporter status. */
export async function handleSupportPrefs(req: Request, env: Env): Promise<Response> {
  const acct = await sessionAccountId(req, env);
  if (!acct) return json({ error: "sign in" }, { status: 401 });
  if (req.method === "POST") {
    const b = (await req.json().catch(() => ({}))) as { hideNag?: boolean };
    await env.DB.prepare("UPDATE accounts SET hide_nag = ? WHERE account_id = ?")
      .bind(b.hideNag ? 1 : 0, acct)
      .run();
  }
  const row = await env.DB.prepare("SELECT tier, hide_nag AS hideNag FROM accounts WHERE account_id = ?")
    .bind(acct)
    .first<{ tier: string; hideNag: number }>();
  return json({ supporter: row?.tier === "supporter", hideNag: (row?.hideNag ?? 0) === 1 });
}

/**
 * POST /api/support/confirm — the trusted-backend hook a payment webhook (or a manual confirm)
 * calls to record a donation: marks the donor's account a supporter (recognition) and appends a
 * public ledger entry. Gated by the ingest secret. NEVER changes any functional capability.
 */
export async function handleSupportConfirm(req: Request, env: Env): Promise<Response> {
  if (!ingestOk(req, env)) return json({ error: "unauthorized" }, { status: 401 });
  const b = (await req.json().catch(() => ({}))) as {
    callsign?: string;
    amountCents?: number;
    currency?: string;
    bucket?: string;
    note?: string;
    source?: string;
  };
  const ts = now();
  let supporter: string | null = null;
  if (b.callsign) {
    const base = b.callsign.toUpperCase().split("-")[0]!;
    const acct =
      (await env.DB.prepare("SELECT account_id FROM account_callsigns WHERE callsign = ?")
        .bind(base)
        .first<{ account_id: string }>()) ??
      (await env.DB.prepare("SELECT account_id FROM accounts WHERE callsign = ?")
        .bind(base)
        .first<{ account_id: string }>());
    if (acct?.account_id) {
      await env.DB.prepare("UPDATE accounts SET tier='supporter' WHERE account_id = ?").bind(acct.account_id).run();
      await env.DB.prepare(
        "INSERT OR IGNORE INTO entitlements (account_id, key, granted_at) VALUES (?, 'supporter_badge', ?)",
      )
        .bind(acct.account_id, ts)
        .run();
      supporter = base;
    }
  }
  if (b.amountCents && b.amountCents > 0) {
    const bucket = (BUCKETS as readonly string[]).includes(b.bucket ?? "") ? b.bucket! : "development";
    await env.DB.prepare(
      "INSERT INTO ledger (ts, direction, bucket, amount_cents, currency, note, source) VALUES (?, 'in', ?, ?, ?, ?, ?)",
    )
      .bind(ts, bucket, Math.round(b.amountCents), b.currency ?? "EUR", b.note ?? null, b.source ?? "manual")
      .run();
  }
  return json({ ok: true, supporter });
}

/** GET /support — a dependency-light public transparency page (server-rendered). */
export async function handleSupportPage(_req: Request, env: Env): Promise<Response> {
  const eur = (c: number) => (c / 100).toLocaleString("en", { style: "currency", currency: "EUR" });
  const ledger = await ledgerSummary(env);
  const links = donationLinks(env);
  const supporters = await publicSupporters(env);
  const esc = (s: string) => s.replace(/[<>&]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" })[c]!);
  const bucketRows = BUCKETS.map(
    (b) =>
      `<tr><td>${b.replace("_", " ")}</td><td>${eur(ledger.buckets[b].inCents)}</td><td>${eur(ledger.buckets[b].outCents)}</td></tr>`,
  ).join("");
  const linkHtml = links.length
    ? links.map((l) => `<a href="${esc(l.url)}" rel="noopener">${esc(l.label)}</a>`).join(" · ")
    : "<span class=m>Donation links are configured per instance.</span>";
  const html = `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">
<title>Support · aprscaching</title><style>
:root{color-scheme:dark light}body{font:15px/1.5 system-ui,sans-serif;max-width:46rem;margin:2rem auto;padding:0 1rem}
h1{font-size:1.4rem}.m{opacity:.7}table{border-collapse:collapse;width:100%;margin:1rem 0}
td,th{border:1px solid #8884;padding:.4rem .6rem;text-align:left}th{font-weight:600}
.big{font-size:1.1rem;font-weight:600}.box{border:1px solid #8884;border-radius:10px;padding:1rem;margin:1rem 0}</style>
<h1>Support aprscaching</h1>
<p><strong>Everyone gets everything for free.</strong> Supporters give because they want the project to
live, and get recognition — a badge and the ability to hide the support prompt — <em>never extra
functionality</em>. No ads, no paywalls. This page is the public ledger.</p>
<div class=box><div class=big>Donate</div><p>${linkHtml}</p></div>
<div class=box><div class=big>Ledger</div>
<p>In ${eur(ledger.totalInCents)} · Out ${eur(ledger.totalOutCents)} · Balance <strong>${eur(ledger.balanceCents)}</strong></p>
<table><tr><th>Bucket</th><th>In</th><th>Out</th></tr>${bucketRows}</table>
<p class=m>Buckets: development, hosting, operation, and peer cost-reimbursement (internet-side only).</p></div>
<div class=box><div class=big>Supporters</div><p>${supporters.length ? supporters.map(esc).join(" · ") : "<span class=m>Be the first — your callsign appears here if your profile is public.</span>"}</p></div>
<p class=m><a href="/source" rel="noopener">Source code (AGPL-3.0)</a> · aprscaching is open source; funded work is public.</p>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
}
