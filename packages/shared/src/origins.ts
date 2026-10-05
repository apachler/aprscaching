// SPDX-License-Identifier: MIT
/**
 * The addresses an instance answers on beside its main one (`EXTRA_ORIGINS`): bare web origins, `https://` or
 * `http://`, a host name or an IPv4 address, an optional port, and nothing after it. The scheme decides
 * everything that differs between them: an https origin gets a certificate and passkeys, an http one serves
 * plain http with a session cookie a browser keeps over it. Which network an origin is on (the internet,
 * 44Net, HAMNET) changes none of that, so the list carries no network tag.
 */

/** `candidate` as a bare http(s) origin (no user, path, query or fragment; a trailing slash is allowed), or null. */
export function bareWebOrigin(candidate: string): URL | null {
  const s = candidate.trim();
  if (!/^https?:\/\/[^/?#\s]+\/?$/i.test(s)) return null;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (u.username || u.password || u.search || u.hash || u.pathname !== "/") return null;
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  return u;
}

/**
 * Parse an origin list (comma- or space-separated): the valid entries as normalised origins, first mention
 * kept, and the entries that are not a bare http(s) origin.
 */
export function parseOriginList(value: string | undefined): { origins: string[]; invalid: string[] } {
  const origins: string[] = [];
  const invalid: string[] = [];
  for (const raw of (value ?? "").split(/[\s,]+/)) {
    if (!raw) continue;
    const u = bareWebOrigin(raw);
    if (!u) invalid.push(raw);
    else if (!origins.includes(u.origin)) origins.push(u.origin);
  }
  return { origins, invalid };
}
