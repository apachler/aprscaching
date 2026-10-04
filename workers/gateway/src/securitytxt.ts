// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * GET /.well-known/security.txt (RFC 9116): where a security researcher reports a problem with this
 * instance. Each contact comes from SECURITY_CONTACT (comma-separated URIs; a bare address becomes a
 * `mailto:`), else `mailto:` + OPERATOR_EMAIL. With neither set the instance names no contact and the
 * file is a 404, because a security.txt without a Contact field is invalid.
 */
import type { Env } from "./env.js";

const UPSTREAM_REPO = "https://github.com/apachler/aprscaching";
const YEAR_MS = 365 * 24 * 3600 * 1000;

/** One contact as an RFC 9116 URI; control characters are dropped so a value cannot add a field. */
function contactUri(raw: string): string | null {
  const v = raw.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (!v) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(v)) return v;
  return v.includes("@") ? `mailto:${v}` : null;
}

/** The instance's security contacts, in the order the operator listed them. */
function securityContacts(env: Env): string[] {
  const configured = (env.SECURITY_CONTACT ?? "").split(",").map(contactUri);
  const list = configured.filter((c): c is string => c !== null);
  if (list.length) return list;
  const op = contactUri(env.OPERATOR_EMAIL ?? "");
  return op ? [op] : [];
}

/**
 * The policy is the SECURITY.md of the published source on its release branch, when that source is on
 * GitHub; any other host has no known path for it, so the field is left out.
 */
function policyUrl(env: Env): string | null {
  const repo = (env.SOURCE_REPO?.trim() || UPSTREAM_REPO).replace(/\/+$/, "").replace(/\.git$/, "");
  return /^https:\/\/github\.com\/[^/]+\/[^/]+$/.test(repo) ? `${repo}/blob/main/SECURITY.md` : null;
}

export function securityTxt(env: Env, now: number = Date.now()): string | null {
  const contacts = securityContacts(env);
  if (!contacts.length) return null;
  const lines = contacts.map((c) => `Contact: ${c}`);
  // A year ahead, computed per request, so the file never goes stale on a long-running instance.
  lines.push(`Expires: ${new Date(now + YEAR_MS).toISOString().replace(/\.\d{3}Z$/, "Z")}`);
  const policy = policyUrl(env);
  if (policy) lines.push(`Policy: ${policy}`);
  lines.push("Preferred-Languages: en, de");
  return lines.join("\n") + "\n";
}

export function handleSecurityTxt(env: Env): Response {
  const body = securityTxt(env);
  if (body === null) return new Response("no security contact configured\n", { status: 404 });
  return new Response(body, {
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=86400" },
  });
}
