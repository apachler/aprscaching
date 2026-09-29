// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * doh.ts — TXT lookups over DNS-over-HTTPS (the JSON API of RFC 8484 resolvers such as Cloudflare's and
 * Google's). Plain fetch, so it runs the same on Workers, Node and Bun. The answer carries the resolver's
 * DNSSEC verdict: `AD` is set only when the resolver validated the whole chain from the root, which is
 * what anchors a record cryptographically rather than by where the answer came from.
 *
 * `DOH_URL` picks the resolver; it must be a validating one that returns the AD flag.
 */
import { trimTrailingSlashes } from "./fetchguard.js";
import type { Env } from "./env.js";

export const DEFAULT_DOH = "https://cloudflare-dns.com/dns-query";
const RESOLVE_TIMEOUT_MS = 5000;

/** DNS response code for a name that does not exist. */
export const NXDOMAIN = 3;

export interface TxtAnswer {
  /** DNS response code: 0 = answered, {@link NXDOMAIN} = no such name. */
  status: number;
  /** The resolver validated the answer with DNSSEC. */
  dnssec: boolean;
  /** Each TXT record's character-strings, joined. */
  txts: string[];
}

interface DohJson {
  Status: number;
  AD?: boolean;
  Answer?: { name: string; type: number; data: string }[];
}

/** One TXT record's presentation data (`"chunk" "chunk"`) as the text it encodes. */
export function unquoteTxt(data: string): string {
  return data.replace(/^"|"$/g, "").replace(/"\s+"/g, "");
}

/** Resolve `name` TXT through the configured resolver. Throws when the resolver itself fails. */
export async function resolveTxt(env: Env, name: string): Promise<TxtAnswer> {
  const doh = trimTrailingSlashes(env.DOH_URL || DEFAULT_DOH);
  const res = await fetch(`${doh}?name=${encodeURIComponent(name)}&type=TXT`, {
    headers: { accept: "application/dns-json" },
    signal: AbortSignal.timeout(RESOLVE_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`DNS resolver ${res.status}`);
  const ans = (await res.json()) as DohJson;
  return {
    status: ans.Status,
    dnssec: ans.AD === true,
    txts: (ans.Answer ?? []).filter((a) => a.type === 16).map((a) => unquoteTxt(a.data)),
  };
}

/** The `key=value` fields of an `acs1` TXT payload (`v=acs1; …`), or null for any other record. */
export function acsFields(txt: string): Map<string, string> | null {
  const fields = new Map<string, string>();
  for (const part of txt.split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0) fields.set(part.slice(0, eq).trim().toLowerCase(), part.slice(eq + 1).trim());
  }
  return fields.get("v") === "acs1" ? fields : null;
}

/** A base call's ARDC-delegated name and the aprscaching record under it. */
export function amprNames(baseCall: string): { host: string; name: string } {
  const host = `${baseCall.toLowerCase()}.ampr.org`;
  return { host, name: `_aprscaching.${host}` };
}
