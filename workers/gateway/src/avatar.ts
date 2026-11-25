// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * avatar.ts — a profile's picture, uploaded to this instance and served from it. A profile never names a picture
 * on another host: every visitor's browser would then tell that host their address, the time and the page they
 * read, a host the profile's owner picks. The picture is a photo in the media store, stripped of what its camera
 * wrote, inside the instance's media quota, the account's export and its erasure, and cleared by moderation.
 *
 *   PUT    /api/my/avatar   the raw photo (JPEG, PNG or WebP) replaces the picture (session-gated)
 *   DELETE /api/my/avatar   remove the picture (session-gated)
 *   GET    /api/media/avatar/<id>.<ext>   the picture, while its profile is public, or to its owner (stages.ts)
 */
import type { Env } from "./env.js";
import { json } from "./http.js";
import { sessionIdentity } from "./auth.js";
import { readCappedBody } from "./fetchguard.js";
import { stripImageMetadata } from "./imagemeta.js";
import { finishMediaDeletes, queueMediaDeletes } from "./mediadeletions.js";
import { instanceMediaRefusal, mediaType, unreadablePhoto } from "./stages.js";
import { MEDIA_LIMITS, mediaMB } from "@aprscaching/shared";

/** The key shape a picture is stored under: a random id, so the address names nobody. */
export const AVATAR_KEY = /^avatar\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(?:jpeg|png|webp)$/;
const AVATAR_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

/** The address a stored picture is served at. */
export const avatarUrl = (key: string | null): string | null => (key ? `/api/media/${key}` : null);

/**
 * Who may see the picture stored under `key`: "public" while its profile is shown, "owner" for the account it
 * belongs to while the profile is hidden, null for anyone else and for a key no account holds.
 */
export async function avatarSeenBy(req: Request, env: Env, key: string): Promise<"public" | "owner" | null> {
  const row = await env.DB.prepare("SELECT account_id, profile_public FROM accounts WHERE avatar_key=?")
    .bind(key)
    .first<{ account_id: string; profile_public: number }>();
  if (!row) return null;
  if (row.profile_public === 1) return "public";
  const me = await sessionIdentity(req, env);
  return me?.accountId === row.account_id ? "owner" : null;
}

/** PUT /api/my/avatar — store the raw photo as the caller's picture, replacing the one before. */
export async function handlePutAvatar(req: Request, env: Env): Promise<Response> {
  if (!env.MEDIA) return json({ error: "media storage not configured" }, { status: 501 });
  const me = await sessionIdentity(req, env);
  if (!me) return json({ error: "sign in to set your picture" }, { status: 401 });
  const ct = mediaType(req.headers.get("content-type"));
  if (!AVATAR_TYPES.has(ct)) return json({ error: "a picture is a photo (JPEG, PNG or WebP)" }, { status: 415 });
  const body = await readCappedBody(req, MEDIA_LIMITS.avatar);
  if (!body?.length) return json({ error: `a picture is at most ${mediaMB(MEDIA_LIMITS.avatar)}` }, { status: 413 });
  const bytes = stripImageMetadata(body, ct);
  if (!bytes) return json({ error: unreadablePhoto(ct) }, { status: 415 });
  const before = await env.DB.prepare("SELECT avatar_key, avatar_bytes FROM accounts WHERE account_id=?")
    .bind(me.accountId)
    .first<{ avatar_key: string | null; avatar_bytes: number | null }>();
  if (!before) return json({ error: "sign in to set your picture" }, { status: 401 });
  const full = await instanceMediaRefusal(env, bytes.length - (before.avatar_bytes ?? 0));
  if (full) return json({ error: full }, { status: 413 });

  const key = `avatar/${crypto.randomUUID()}.${ct.slice("image/".length)}`;
  await env.MEDIA.put(key, bytes, ct);
  const old = before.avatar_key ? [before.avatar_key] : [];
  await env.DB.batch([
    env.DB.prepare("UPDATE accounts SET avatar_key=?, avatar_bytes=? WHERE account_id=?").bind(
      key,
      bytes.length,
      me.accountId,
    ),
    ...queueMediaDeletes(env, old),
  ]);
  await finishMediaDeletes(env, old);
  return json({ ok: true, avatarUrl: avatarUrl(key) });
}

/** DELETE /api/my/avatar — remove the caller's picture. */
export async function handleDeleteAvatar(req: Request, env: Env): Promise<Response> {
  const me = await sessionIdentity(req, env);
  if (!me) return json({ error: "sign in to remove your picture" }, { status: 401 });
  const row = await env.DB.prepare("SELECT avatar_key FROM accounts WHERE account_id=?")
    .bind(me.accountId)
    .first<{ avatar_key: string | null }>();
  const old = row?.avatar_key ? [row.avatar_key] : [];
  await env.DB.batch([
    env.DB.prepare("UPDATE accounts SET avatar_key=NULL, avatar_bytes=NULL WHERE account_id=?").bind(me.accountId),
    ...queueMediaDeletes(env, old),
  ]);
  await finishMediaDeletes(env, old);
  return json({ ok: true });
}
