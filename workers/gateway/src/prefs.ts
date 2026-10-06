// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * prefs.ts — account-level UI preferences. A person's device-independent UI settings —
 * theme, locale/units, pinned shack apps, basemap, installed tools — follow the ACCOUNT so a second device
 * restores them on sign-in. One small validated JSON blob per account; guests keep the same in
 * localStorage only. Keyed by account_id (person). Inside the GDPR export/erase.
 *
 *   GET /api/prefs   → { prefs }       my synced UI prefs (session)
 *   PUT /api/prefs   { prefs } → { ok } replace them (validated + size-capped)
 */
import { nowS } from "./util/time.js";
import type { Env } from "./env.js";
import { json } from "./http.js";
import { sessionIdentity } from "./auth.js";

const UNITS = new Set(["metric", "imperial"]);
// The Appearance choices (apps/web format.ts Theme).
const THEMES = new Set(["auto", "light", "dark", "phosphor"]);
const MAX_BYTES = 16_384;
/** Installed tools kept per account, and the shape of one record (apps/web/src/tools/installed.ts). */
const MAX_TOOLS = 40;
const TOOL_NAME = /^[a-z0-9][a-z0-9-]{1,39}$/;
const CAPABILITIES = new Set([
  "command",
  "monitor",
  "event",
  "decoder",
  "panel",
  "map",
  "ipc",
  "beacon",
  "network",
  "tx",
  "geo",
]);

/** One installed tool: its manifest address, the author key, grants, origins and remote use approved, the switch. */
function sanitizeTool(x: unknown): Record<string, unknown> | null {
  if (!x || typeof x !== "object") return null;
  const t = x as Record<string, unknown>;
  if (typeof t.name !== "string" || !TOOL_NAME.test(t.name)) return null;
  if (typeof t.url !== "string" || !/^https?:\/\//.test(t.url) || t.url.length > 500) return null;
  if (typeof t.pubkey !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(t.pubkey)) return null;
  const grants = Array.isArray(t.grants) ? t.grants.filter((g): g is string => CAPABILITIES.has(String(g))) : [];
  const connect = Array.isArray(t.connect)
    ? t.connect
        .filter((o): o is string => typeof o === "string" && /^(https|wss):\/\/[^/\s]+$/.test(o) && o.length <= 120)
        .slice(0, 8)
    : [];
  const title = typeof t.title === "string" ? t.title.slice(0, 80) : t.name;
  const out: Record<string, unknown> = {
    name: t.name,
    title,
    url: t.url,
    pubkey: t.pubkey,
    grants,
    connect,
    remote: t.remote === true,
    on: t.on === true,
  };
  const via = t.via as Record<string, unknown> | undefined;
  if (via && typeof via === "object" && typeof via.id === "string" && via.id.length <= 64)
    out.via = { id: via.id, account: via.account === true };
  return out;
}

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
  // pinned shack apps and tools (ids only, capped; a tool pin is `tool:` and a name of up to 40 characters)
  if (Array.isArray(b.pins))
    out.pins = b.pins
      .filter((x): x is string => typeof x === "string")
      .slice(0, 20)
      .map((s) => s.slice(0, 45));
  // installed tools, one record per tool name
  if (Array.isArray(b.tools)) {
    const seen = new Set<string>();
    out.tools = b.tools
      .map(sanitizeTool)
      .filter((t): t is Record<string, unknown> => !!t && !seen.has(t.name as string) && !!seen.add(t.name as string))
      .slice(0, MAX_TOOLS);
  }
  // basemap choice
  if (typeof b.basemap === "string") out.basemap = b.basemap.slice(0, 24);

  return out;
}

const parse = (s: string): Record<string, unknown> => {
  try {
    const v = JSON.parse(s);
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
};

export async function handlePrefsGet(req: Request, env: Env): Promise<Response> {
  const me = await sessionIdentity(req, env);
  if (!me) return json({ error: "sign in" }, { status: 401 });
  const row = await env.DB.prepare("SELECT prefs FROM account_prefs WHERE account_id=?")
    .bind(me.accountId)
    .first<{ prefs: string }>();
  return json({ prefs: row ? parse(row.prefs) : {} });
}

export async function handlePrefsPut(req: Request, env: Env): Promise<Response> {
  const me = await sessionIdentity(req, env);
  if (!me) return json({ error: "sign in" }, { status: 401 });
  const body = (await req.json().catch(() => ({}))) as { prefs?: unknown };
  const prefs = sanitizePrefs(body.prefs);
  const str = JSON.stringify(prefs);
  if (str.length > MAX_BYTES) return json({ error: "prefs too large" }, { status: 400 });
  await env.DB.prepare(
    "INSERT INTO account_prefs (account_id, prefs, updated_at) VALUES (?,?,?) " +
      "ON CONFLICT(account_id) DO UPDATE SET prefs=excluded.prefs, updated_at=excluded.updated_at",
  )
    .bind(me.accountId, str, nowS())
    .run();
  return json({ ok: true, prefs });
}
