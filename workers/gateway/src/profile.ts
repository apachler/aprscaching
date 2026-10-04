// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * profile.ts — the thin, opt-in ham profile. Self-curated fields (display name, locator,
 * avatar, bio, links, public contact) with a master show/hide. Server-side sanitizes bio + links and
 * validates the grid; everything is account-owned and inside the GDPR export/erase.
 *
 *   GET  /api/my/profile  read your own profile, every field and the show/hide switch (session-gated)
 *   POST /auth/profile    update your own profile (session-gated)
 * (GET /api/profile/:call is extended in community.ts to surface the public fields.)
 */
import type { Env } from "./env.js";
import { json, asStr } from "./app.js";
import { sessionIdentity } from "./auth.js";
import { gridToLatLon } from "@aprscaching/shared";
import { stripTags } from "./util/html.js";

const httpUrl = (u: unknown): string | null => {
  const s = asStr(u).trim();
  return /^https?:\/\/[^\s]+$/i.test(s) && s.length <= 300 ? s : null;
};

/** Up to 5 labelled links, http(s) only, label + url length-capped. */
export function sanitizeLinks(raw: unknown): { label: string; url: string }[] {
  if (!Array.isArray(raw)) return [];
  const out: { label: string; url: string }[] = [];
  for (const item of raw.slice(0, 5)) {
    const url = httpUrl((item as { url?: unknown })?.url);
    if (!url) continue;
    const label =
      asStr((item as { label?: unknown })?.label)
        .replace(/[<>]/g, "")
        .slice(0, 40) || new URL(url).hostname;
    out.push({ label, url });
  }
  return out;
}

/** Plain text only — strip tags + control chars, cap length. */
export function sanitizeBio(raw: unknown): string | null {
  const s = stripTags(asStr(raw))
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .trim()
    .slice(0, 500);
  return s || null;
}

/** A display name is one short line of text: tags and any stray angle bracket are removed. */
export function sanitizeDisplayName(raw: unknown): string | null {
  return stripTags(asStr(raw)).replace(/[<>]/g, "").trim().slice(0, 60) || null;
}

const emailish = (u: unknown): string | null => {
  const s = asStr(u).trim();
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s) && s.length <= 120 ? s.toLowerCase() : null;
};

/**
 * GET /api/my/profile — the caller's own profile as the editor needs it: every field, also while the
 * profile is hidden, and the show/hide switch. The public profile omits both, so an editor seeded from it
 * would save a hidden profile back as blank and public.
 */
export async function handleMyProfile(req: Request, env: Env): Promise<Response> {
  const me = await sessionIdentity(req, env);
  if (!me) return json({ error: "sign in to edit your profile" }, { status: 401 });
  const r = await env.DB.prepare(
    `SELECT display_name AS displayName, home_grid AS homeGrid, avatar_url AS avatarUrl, bio, links,
            public_contact AS publicContact, profile_public AS profilePublic
       FROM accounts WHERE account_id=?`,
  )
    .bind(me.accountId)
    .first<{
      displayName: string | null;
      homeGrid: string | null;
      avatarUrl: string | null;
      bio: string | null;
      links: string | null;
      publicContact: string | null;
      profilePublic: number | null;
    }>();
  if (!r) return json({ error: "sign in to edit your profile" }, { status: 401 });
  let links: unknown;
  try {
    links = r.links ? JSON.parse(r.links) : [];
  } catch {
    links = [];
  }
  return json({
    profile: {
      displayName: r.displayName,
      homeGrid: r.homeGrid,
      avatarUrl: r.avatarUrl,
      bio: r.bio,
      links: Array.isArray(links) ? links : [],
      publicContact: r.publicContact,
      profilePublic: (r.profilePublic ?? 1) === 1,
    },
  });
}

/** POST /auth/profile — replace the caller's profile from a full form payload. */
export async function handleProfileUpdate(req: Request, env: Env): Promise<Response> {
  const me = await sessionIdentity(req, env);
  if (!me) return json({ error: "sign in to edit your profile" }, { status: 401 });
  const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;

  const displayName = sanitizeDisplayName(b.displayName);
  const gridRaw = asStr(b.homeGrid).trim();
  if (gridRaw && !gridToLatLon(gridRaw)) return json({ error: "invalid Maidenhead locator" }, { status: 400 });
  const homeGrid = gridRaw ? gridRaw.toUpperCase() : null;
  const avatarUrl = asStr(b.avatarUrl).trim() ? httpUrl(b.avatarUrl) : null;
  if (asStr(b.avatarUrl).trim() && !avatarUrl) return json({ error: "avatar must be an http(s) URL" }, { status: 400 });
  const bio = sanitizeBio(b.bio);
  const links = JSON.stringify(sanitizeLinks(b.links));
  const publicContact = asStr(b.publicContact).trim() ? emailish(b.publicContact) : null;
  if (asStr(b.publicContact).trim() && !publicContact)
    return json({ error: "public contact must be a valid email" }, { status: 400 });
  const profilePublic = b.profilePublic === false ? 0 : 1;

  await env.DB.prepare(
    `UPDATE accounts SET display_name=?, home_grid=?, avatar_url=?, bio=?, links=?, public_contact=?, profile_public=? WHERE account_id=?`,
  )
    .bind(displayName, homeGrid, avatarUrl, bio, links, publicContact, profilePublic, me.accountId)
    .run();

  return json({
    ok: true,
    profile: {
      displayName,
      homeGrid,
      avatarUrl,
      bio,
      links: JSON.parse(links),
      publicContact,
      profilePublic: profilePublic === 1,
    },
  });
}
