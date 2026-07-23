// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * profile.ts — the thin, opt-in ham profile. Self-curated fields (display name, locator,
 * avatar, bio, links, public contact) with a master show/hide. Server-side sanitizes bio + links and
 * validates the grid; everything is account-owned and inside the GDPR export/erase.
 *
 *   POST /auth/profile   update your own profile (session-gated)
 * (GET /api/profile/:call is extended in community.ts to surface the public fields.)
 */
import type { Env } from "./env.js";
import { json, asStr } from "./app.js";
import { sessionCallsign } from "./auth.js";
import { gridToLatLon } from "@aprscaching/shared";

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
  const s = asStr(raw)
    .replace(/<[^>]*>/g, "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .trim()
    .slice(0, 500);
  return s || null;
}

const emailish = (u: unknown): string | null => {
  const s = asStr(u).trim();
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s) && s.length <= 120 ? s.toLowerCase() : null;
};

/** POST /auth/profile — replace the caller's profile from a full form payload. */
export async function handleProfileUpdate(req: Request, env: Env): Promise<Response> {
  const cs = await sessionCallsign(req, env);
  if (!cs) return json({ error: "sign in to edit your profile" }, { status: 401 });
  const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;

  const displayName =
    asStr(b.displayName)
      .replace(/<[^>]*>/g, "")
      .replace(/[<>]/g, "")
      .trim()
      .slice(0, 60) || null;
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
    `UPDATE accounts SET display_name=?, home_grid=?, avatar_url=?, bio=?, links=?, public_contact=?, profile_public=? WHERE callsign=?`,
  )
    .bind(displayName, homeGrid, avatarUrl, bio, links, publicContact, profilePublic, cs.toUpperCase())
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
