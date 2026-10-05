// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * apikeys.ts — read-API keys. A key belongs to a signed-in account, which creates, lists and revokes its own
 * under Settings → Developer; the sysop sees and revokes every key from Instance admin. A key only raises the
 * read API's rate limit (readapi.ts): the read API stays free without one, and no feature is gated on a key.
 *
 * The instance stores the SHA-256 of each key, never the key: it is shown once, at creation. Lists show the
 * key's prefix, enough to tell keys apart.
 *
 *   GET    /api/keys                 the account's keys and its cap
 *   POST   /api/keys {name}          create a key → the full key, once
 *   DELETE /api/keys/:id             revoke one of the account's keys
 *   GET    /api/admin/api-keys       every key on the instance, with its owner (sysop)
 *   DELETE /api/admin/api-keys/:id   revoke any key (sysop)
 */
import type { Env } from "./env.js";
import { json } from "./app.js";
import { setting } from "./siteconfig.js";
import { sessionIdentity } from "./auth.js";
import { requireSysop } from "./admin.js";
import { rateLimitedDurable } from "./corroborate_privacy.js";
import { nowS } from "./util/time.js";

/** The keys an account may hold at once, unless API_KEYS_PER_ACCOUNT says otherwise. */
const DEFAULT_CAP = 5;
/** Characters of a key shown in lists: the `acg_` mark and eight more. */
const PREFIX_LEN = 12;
const NAME_MAX = 60;
/** A key's last use is written at most this often, so a busy key does not cost a write per request. */
const LAST_USED_RESOLUTION_S = 3600;

/** The keys an account may hold; `0` lets nobody create one. */
const apiKeyCap = (env: Env): number => {
  const n = Number(setting(env, "API_KEYS_PER_ACCOUNT") || DEFAULT_CAP);
  return Number.isInteger(n) && n >= 0 ? n : DEFAULT_CAP;
};

async function hashKey(key: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** A stored key as its owner and the sysop see it: never the key itself. */
interface KeyRow {
  id: number;
  name: string;
  prefix: string;
  createdAt: number;
  lastUsedAt: number | null;
}
const KEY_COLS = "id, name, prefix, created_at AS createdAt, last_used_at AS lastUsedAt";

/**
 * The key a read-API request presents, or null for an unknown one. Records the key's last use, at most once
 * an hour.
 */
export async function lookupApiKey(env: Env, raw: string): Promise<{ id: number } | null> {
  const row = await env.DB.prepare("SELECT id, last_used_at AS lastUsedAt FROM api_keys WHERE key_hash = ?")
    .bind(await hashKey(raw))
    .first<{ id: number; lastUsedAt: number | null }>();
  if (!row) return null;
  const now = nowS();
  if (row.lastUsedAt === null || now - row.lastUsedAt >= LAST_USED_RESOLUTION_S)
    try {
      await env.DB.prepare("UPDATE api_keys SET last_used_at = ? WHERE id = ?").bind(now, row.id).run();
    } catch {
      /* the last-use stamp is informational */
    }
  return { id: row.id };
}

/** The presented key's own record, for GET /api/v1/key. */
export async function describeApiKey(env: Env, raw: string): Promise<KeyRow | null> {
  return env.DB.prepare(`SELECT ${KEY_COLS} FROM api_keys WHERE key_hash = ?`)
    .bind(await hashKey(raw))
    .first<KeyRow>();
}

/** GET · POST /api/keys — the signed-in account's keys, and creating one. */
export async function handleMyApiKeys(req: Request, env: Env): Promise<Response> {
  const me = await sessionIdentity(req, env);
  if (!me) return json({ error: "sign in to manage your API keys" }, { status: 401 });
  const cap = apiKeyCap(env);
  const mine = async () =>
    (
      await env.DB.prepare(`SELECT ${KEY_COLS} FROM api_keys WHERE account_id = ? ORDER BY created_at, id`)
        .bind(me.accountId)
        .all<KeyRow>()
    ).results;
  if (req.method === "GET") return json({ keys: await mine(), cap });
  if (req.method !== "POST") return json({ error: "method not allowed" }, { status: 405 });

  const body = (await req.json().catch(() => ({}))) as { name?: unknown };
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) return json({ error: "give the key a name, such as the app or script that uses it" }, { status: 400 });
  if (name.length > NAME_MAX) return json({ error: `a key name is at most ${NAME_MAX} characters` }, { status: 400 });
  const held = (
    await env.DB.prepare("SELECT COUNT(*) AS n FROM api_keys WHERE account_id = ?")
      .bind(me.accountId)
      .first<{ n: number }>()
  )?.n;
  if ((held ?? 0) >= cap)
    return json(
      { error: `you have ${cap} API keys, the most this instance allows: revoke one to create another`, cap },
      { status: 409 },
    );
  // Revoking and creating again stays possible, but not as a loop that mints keys
  if (await rateLimitedDurable(env, `apikeycreate:${me.accountId}`, Date.now(), 10, 3_600_000))
    return json({ error: "too many keys created in the last hour; try again later" }, { status: 429 });

  const key = "acg_" + crypto.randomUUID().replace(/-/g, "");
  const createdAt = nowS();
  const res = await env.DB.prepare(
    "INSERT INTO api_keys (key_hash, prefix, account_id, name, created_at) VALUES (?,?,?,?,?) RETURNING id",
  )
    .bind(await hashKey(key), key.slice(0, PREFIX_LEN), me.accountId, name, createdAt)
    .first<{ id: number }>();
  return json(
    { id: res?.id, key, name, prefix: key.slice(0, PREFIX_LEN), createdAt, lastUsedAt: null },
    { status: 201 },
  );
}

/** DELETE /api/keys/:id — revoke one of the account's own keys. */
export async function handleRevokeMyApiKey(req: Request, env: Env, id: number): Promise<Response> {
  const me = await sessionIdentity(req, env);
  if (!me) return json({ error: "sign in to manage your API keys" }, { status: 401 });
  const row = await env.DB.prepare("SELECT id FROM api_keys WHERE id = ? AND account_id = ?")
    .bind(id, me.accountId)
    .first();
  if (!row) return json({ error: "no such key" }, { status: 404 });
  await env.DB.prepare("DELETE FROM api_keys WHERE id = ? AND account_id = ?").bind(id, me.accountId).run();
  return json({ revoked: true });
}

/** GET /api/admin/api-keys — every key on the instance with its owner's call. Sysop-only. */
export async function handleAdminApiKeys(req: Request, env: Env): Promise<Response> {
  const denied = await requireSysop(req, env, { allowOperatorSecret: true });
  if (denied) return denied;
  const keys = (
    await env.DB.prepare(
      `SELECT k.id, k.name, k.prefix, k.created_at AS createdAt, k.last_used_at AS lastUsedAt, a.callsign AS owner
         FROM api_keys k LEFT JOIN accounts a ON a.account_id = k.account_id
        ORDER BY k.last_used_at IS NULL, k.last_used_at DESC, k.created_at DESC`,
    ).all<KeyRow & { owner: string | null }>()
  ).results;
  return json({ keys, cap: apiKeyCap(env) });
}

/** DELETE /api/admin/api-keys/:id — revoke any key, such as one used to scrape. Sysop-only. */
export async function handleAdminRevokeApiKey(req: Request, env: Env, id: number): Promise<Response> {
  const denied = await requireSysop(req, env, { allowOperatorSecret: true });
  if (denied) return denied;
  const row = await env.DB.prepare("SELECT id FROM api_keys WHERE id = ?").bind(id).first();
  if (!row) return json({ error: "no such key" }, { status: 404 });
  await env.DB.prepare("DELETE FROM api_keys WHERE id = ?").bind(id).run();
  return json({ revoked: true });
}
