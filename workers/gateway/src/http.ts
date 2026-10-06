// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * http.ts — the response and request-body helpers every handler shares. A leaf module: it imports nothing, so a
 * feature module takes these without reaching into the router (app.ts).
 */

export function json(data: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

/**
 * Coerce an untrusted request-body field to a string. Primitives stringify as usual; an object (or
 * null/undefined/symbol) becomes "" — a malformed body `{call: {}}` can never inject "[object Object]"
 * into a stored/echoed value. Use this at every request-body boundary instead of `String(x ?? "")`.
 */
export function asStr(v: unknown): string {
  const t = typeof v;
  return t === "string" || t === "number" || t === "boolean" || t === "bigint" ? String(v) : "";
}

/** XML/RSS/text responses (sitemap, RSS feeds, robots.txt) — content-type defaults to XML. */
export function xml(body: string, init: ResponseInit = {}): Response {
  return new Response(body, {
    ...init,
    headers: { "content-type": "application/xml; charset=utf-8", ...(init.headers ?? {}) },
  });
}
