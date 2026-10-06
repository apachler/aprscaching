// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * sitesettings.ts — the policy values a sysop tunes while the instance runs, kept in the database and edited in
 * Instance admin → Instance settings. Infrastructure and secrets stay in the environment (12-factor); which keys
 * are site settings is the `site` field of the configuration schema (packages/shared configkeys.ts).
 *
 * The precedence rule (environment, else the stored row, else the schema default) and the read path are
 * siteconfig.ts.
 *
 *   GET    /api/admin/settings        every site setting: value, source, default, constraints, label and hint
 *   PUT    /api/admin/settings/:key   {value} — store a value; 409 while the environment sets the key
 *   DELETE /api/admin/settings/:key   back to the default; 409 while the environment sets the key
 *
 * Every route passes `requireSysop` (or the operator secret, for doctor and scripts); a change is rate-limited
 * and lands in the moderation audit log, which already holds who did what on this instance and when.
 */
import {
  CONFIG_KEYS,
  RETENTION_FIELDS,
  SITE_GROUPS,
  SITE_SETTING_KEYS,
  checkSiteValue,
  isFlagKey,
  isSiteSettingKey,
  type ConfigKey,
  type SiteSettingKey,
} from "@aprscaching/shared";
import { CONFIG_HINTS, RETENTION_FIELD_LABELS, SITE_GROUP_TITLES, SITE_TEXT } from "@aprscaching/shared/configdocs";
import type { Env } from "./env.js";
import { json } from "./app.js";
import { requireSysop } from "./admin.js";
import { actorOf, audit } from "./moderation.js";
import { rateLimitedDurable } from "./corroborate_privacy.js";
import { nowS } from "./util/time.js";
import { envSetting, loadSiteSettings, setting, settingSource } from "./siteconfig.js";

/** Changes one sysop may make in an hour. */
const WRITES_PER_HOUR = 120;
/** The longest old → new summary an audit row keeps. */
const AUDIT_TEXT_MAX = 400;

interface Row {
  key: string;
  value: string;
  updated_at: number;
  updated_by: string;
}

/** One setting as the Instance settings page shows it. */
function view(env: Env, key: SiteSettingKey, row: Row | undefined) {
  const k = CONFIG_KEYS[key] as ConfigKey;
  const s = k.site!;
  const source = settingSource(env, key);
  return {
    key,
    group: s.group,
    label: SITE_TEXT[key].label,
    hint: SITE_TEXT[key].hint ?? CONFIG_HINTS[key],
    type: k.type,
    control: isFlagKey(key) ? "switch" : null,
    values: k.values ?? null,
    min: s.min ?? null,
    max: s.max ?? null,
    unit: s.unit ?? null,
    options: s.options ?? null,
    format: s.format ?? null,
    maxLength: s.maxLength ?? null,
    fields:
      s.format === "retention"
        ? Object.entries(RETENTION_FIELDS).map(([id, f]) => ({
            id,
            label: RETENTION_FIELD_LABELS[id as keyof typeof RETENTION_FIELDS],
            default: f.default,
            min: f.min,
            max: f.max,
            unit: f.unit,
          }))
        : null,
    default: k.default ?? null,
    value: setting(env, key) ?? null,
    source,
    // when and by whom it was last changed here; kept while the environment overrides it, so the page can say so
    stored: row ? { value: row.value, at: row.updated_at, by: row.updated_by } : null,
  };
}

async function storedRows(env: Env): Promise<Map<string, Row>> {
  const rows = (await env.DB.prepare("SELECT key, value, updated_at, updated_by FROM site_settings").all<Row>())
    .results;
  return new Map(rows.map((r) => [r.key, r]));
}

async function handleList(env: Env): Promise<Response> {
  await loadSiteSettings(env, true);
  const rows = await storedRows(env);
  return json({
    groups: SITE_GROUPS.map((id) => ({ id, title: SITE_GROUP_TITLES[id] })),
    settings: SITE_SETTING_KEYS.map((k) => view(env, k, rows.get(k))),
  });
}

const clip = (s: string) => (s.length > AUDIT_TEXT_MAX ? `${s.slice(0, AUDIT_TEXT_MAX - 1)}…` : s);

async function handleWrite(req: Request, env: Env, key: SiteSettingKey, reset: boolean): Promise<Response> {
  if (envSetting(env, key) !== undefined)
    return json(
      { error: `${key} is set by the environment, which wins; change it there and restart the gateway` },
      { status: 409 },
    );
  const actor = await actorOf(req, env);
  if (await rateLimitedDurable(env, `settings:${actor}`, Date.now(), WRITES_PER_HOUR, 3600_000))
    return json({ error: "too many setting changes; try again later" }, { status: 429 });
  let next: string | null = null;
  if (!reset) {
    const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const r = checkSiteValue(key, b.value);
    if ("error" in r) return json({ error: r.error }, { status: 400 });
    next = r.value;
  }
  await loadSiteSettings(env, true);
  const before = setting(env, key);
  const was = settingSource(env, key) === "site" ? before : undefined;
  const write =
    next === null
      ? env.DB.prepare("DELETE FROM site_settings WHERE key=?").bind(key)
      : env.DB.prepare(
          `INSERT INTO site_settings (key, value, updated_at, updated_by) VALUES (?,?,?,?)
           ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at, updated_by=excluded.updated_by`,
        ).bind(key, next, nowS(), actor);
  const changed = next !== null ? was !== next : was !== undefined;
  const statements = [write];
  if (changed)
    statements.push(
      audit(env, {
        actor,
        action: next === null ? "reset" : "set",
        kind: "setting",
        id: key,
        label: key,
        reason: clip(`${was ?? `default (${before ?? "none"})`} → ${next ?? "default"}`),
      }),
    );
  await env.DB.batch(statements);
  await loadSiteSettings(env, true);
  const rows = await storedRows(env);
  return json({ setting: view(env, key, rows.get(key)) });
}

/** /api/admin/settings[/:key] — the sysop's (or the operator secret's) alone. */
export async function handleAdminSettings(req: Request, env: Env, key?: string): Promise<Response> {
  const denied = await requireSysop(req, env, { allowOperatorSecret: true });
  if (denied) return denied;
  const m = req.method;
  if (key === undefined) return m === "GET" ? handleList(env) : new Response("method not allowed", { status: 405 });
  if (!isSiteSettingKey(key)) return json({ error: `${key} is not an instance setting` }, { status: 404 });
  if (m === "PUT") return handleWrite(req, env, key, false);
  if (m === "DELETE") return handleWrite(req, env, key, true);
  return new Response("method not allowed", { status: 405 });
}
