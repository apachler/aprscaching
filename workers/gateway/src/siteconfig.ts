// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * siteconfig.ts — the one read path for a site setting (a policy value the sysop may set in Instance admin →
 * Instance settings; sitesettings.ts serves that page). One rule decides each value, so a setting has exactly
 * one visible source:
 *   1. the environment, when it sets the key (a blank value counts as unset, as compose passes `${VAR:-}`);
 *   2. else the stored row in `site_settings`;
 *   3. else the schema default.
 * `setting()` is synchronous: `loadSiteSettings()` reads the stored rows once per request and per scheduled run
 * into a small in-process cache. A write replaces the cache at once, and the cache expires after a short while,
 * so a second process on the same database follows within seconds. This module imports nothing of the router,
 * so any module may read a setting through it.
 */
import { CONFIG_KEYS, isSiteSettingKey, type ConfigKey, type SiteSettingKey } from "@aprscaching/shared";
import type { Env } from "./env.js";

/** How long the cached rows serve before the next request reads them again. */
const CACHE_TTL_MS = 30_000;

interface Cached {
  values: Map<string, string>;
  at: number;
}
/** The stored rows per database: one gateway process may serve several (the tests do). */
const cache = new WeakMap<object, Cached>();

const dbOf = (env: Env): object | undefined => env.DB;

/** Read the stored rows into the cache unless a fresh copy is there. Never throws: a failed read keeps none. */
export async function loadSiteSettings(env: Env, force = false): Promise<void> {
  const db = dbOf(env);
  if (!db) return;
  const hit = cache.get(db);
  if (!force && hit && Date.now() - hit.at < CACHE_TTL_MS) return;
  const values = new Map<string, string>();
  try {
    const rows = (await env.DB.prepare("SELECT key, value FROM site_settings").all<{ key: string; value: string }>())
      .results;
    for (const r of rows) if (isSiteSettingKey(r.key)) values.set(r.key, r.value);
  } catch {
    // an unreadable table leaves the environment and the defaults in charge
  }
  cache.set(db, { values, at: Date.now() });
}

/** The environment's value of `key`, when it sets one. */
export const envSetting = (env: Env, key: SiteSettingKey): string | undefined => {
  const v = (env as unknown as Record<string, unknown>)[key];
  return typeof v === "string" && v.trim() !== "" ? v : undefined;
};

const stored = (env: Env, key: SiteSettingKey): string | undefined => {
  const db = dbOf(env);
  return db ? cache.get(db)?.values.get(key) : undefined;
};

/** Where a setting's value comes from. */
type SettingSource = "env" | "site" | "default";

/** The source of `key` under the precedence rule. */
export function settingSource(env: Env, key: SiteSettingKey): SettingSource {
  if (envSetting(env, key) !== undefined) return "env";
  return stored(env, key) !== undefined ? "site" : "default";
}

/**
 * The value of a site setting: the environment's when it sets the key, else the stored one, else the schema
 * default (undefined when the schema has none).
 */
export function setting(env: Env, key: SiteSettingKey): string | undefined {
  return envSetting(env, key) ?? stored(env, key) ?? (CONFIG_KEYS[key] as ConfigKey).default;
}
