// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * prefs.ts — account-level UI preferences. A person's device-independent UI settings —
 * theme, locale/units, pinned workbench apps, basemap — follow the ACCOUNT so a second device
 * restores them on sign-in. One small validated JSON blob per account; guests keep the same in
 * localStorage only. Keyed by account_id (person), per ADR-1/ADR-2. Inside the GDPR export/erase.
 *
 *   GET /api/prefs   → { prefs }       my synced UI prefs (session)
 *   PUT /api/prefs   { prefs } → { ok } replace them (validated + size-capped)
 */
import type { Env } from "./env.js";
import { json } from "./app.js";
import { sessionAccountId } from "./auth.js";

const now = () => Math.floor(Date.now() / 1000);
const UNITS = new Set(["metric", "imperial"]);
// v1 themes are "modern"/"cogmind"; the legacy dark/light/auto are still accepted so old
// stored prefs validate (the client's normalizeTheme folds anything non-cogmind → modern).
const THEMES = new Set(["modern", "cogmind", "dark", "light", "auto"]);
const MAX_BYTES = 4096;

/**
 * Keep only the known UI-pref keys, coercing each to a safe shape — the client owns the exact
 * semantics; the server just prevents junk/bloat from being stored. Unknown keys are dropped.
 */
export function sanitizePrefs(raw: unknown): Record<string, unknown> {
  const b = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const out: Record<string, unknown> = {};

  // locale/units/theme (the format.ts LocaleSettings blob)
  if (b.locale && typeof b.locale === "object") {
    const l = b.locale as Record<string, unknown>;
    const loc: Record<string, unknown> = {};
    if (typeof l.locale === "string") loc.locale = l.locale.slice(0, 35);
    if (typeof l.timeZone === "string") loc.timeZone = l.timeZone.slice(0, 48);
    if (UNITS.has(String(l.units))) loc.units = l.units;
    if (THEMES.has(String(l.theme))) loc.theme = l.theme;
    out.locale = loc;
  }
  // pinned workbench apps (ids only, capped)
  if (Array.isArray(b.pins))
    out.pins = b.pins.filter((x): x is string => typeof x === "string").slice(0, 20).map((s) => s.slice(0, 24));
  // basemap choice
  if (typeof b.basemap === "string") out.basemap = b.basemap.slice(0, 24);

  return out;
}

const parse = (s: string): Record<string, unknown> => { try { const v = JSON.parse(s); return v && typeof v === "object" ? v : {}; } catch { return {}; } };

export async function handlePrefsGet(req: Request, env: Env): Promise<Response> {
  const me = await sessionAccountId(req, env);
  if (!me) return json({ error: "sign in" }, { status: 401 });
  const row = await env.DB.prepare("SELECT prefs FROM account_prefs WHERE account_id=?").bind(me.accountId).first<{ prefs: string }>();
  return json({ prefs: row ? parse(row.prefs) : {} });
}

export async function handlePrefsPut(req: Request, env: Env): Promise<Response> {
  const me = await sessionAccountId(req, env);
  if (!me) return json({ error: "sign in" }, { status: 401 });
  const body = (await req.json().catch(() => ({}))) as { prefs?: unknown };
  const prefs = sanitizePrefs(body.prefs);
  const str = JSON.stringify(prefs);
  if (str.length > MAX_BYTES) return json({ error: "prefs too large" }, { status: 400 });
  await env.DB.prepare(
    "INSERT INTO account_prefs (account_id, prefs, updated_at) VALUES (?,?,?) " +
    "ON CONFLICT(account_id) DO UPDATE SET prefs=excluded.prefs, updated_at=excluded.updated_at",
  ).bind(me.accountId, str, now()).run();
  return json({ ok: true, prefs });
}
