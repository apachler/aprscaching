// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * doh.ts — DNS lookups (TXT, A, AAAA) over DNS-over-HTTPS, through the JSON API that Cloudflare (`/dns-query`), Google
 * (`/resolve`) and Quad9 (`:5053/dns-query`) serve: `?name=&type=` with `accept: application/dns-json`,
 * answering `{Status, AD, Answer: [{name, type, data}]}`. The dialects differ only in presentation —
 * Google writes owner names with a trailing dot and TXT data unquoted, Cloudflare quotes each
 * character-string — and both normalise here. Plain fetch, so it runs the same on Node and Bun.
 * The answer carries the resolver's DNSSEC verdict: `AD` is set only when the resolver validated the
 * whole chain from the root, which is what anchors a record cryptographically rather than by where the
 * answer came from.
 *
 * `DOH_URL` picks the validating resolver; it must be one that returns the AD flag.
 */
import { trimTrailingSlashes } from "./fetchguard.js";
import type { Env } from "./env.js";

const DEFAULT_DOH = "https://cloudflare-dns.com/dns-query";
/** Independent public resolvers, run by three different operators, for answers DNSSEC cannot vouch for. */
const DEFAULT_AMPR_RESOLVERS = [
  "https://cloudflare-dns.com/dns-query",
  "https://dns.google/resolve",
  "https://dns.quad9.net:5053/dns-query",
] as const;
const RESOLVE_TIMEOUT_MS = 5000;

/** DNS response code for a name that does not exist. */
export const NXDOMAIN = 3;
/** The record types this module looks up, by their DNS type numbers. */
const RECORD_TYPES = { A: 1, TXT: 16, AAAA: 28 } as const;
export type RecordType = keyof typeof RECORD_TYPES;
/** Alias records: an answer through one of these left the queried name. */
const TYPE_CNAME = 5;
const TYPE_DNAME = 39;

export interface TxtAnswer {
  /** DNS response code: 0 = answered, {@link NXDOMAIN} = no such name. */
  status: number;
  /** The resolver validated the answer with DNSSEC. */
  dnssec: boolean;
  /** Each TXT record's character-strings, joined. */
  txts: string[];
  /** The answer went through a CNAME or DNAME. */
  alias: boolean;
  /** Every answer record is owned by exactly the queried name. */
  exact: boolean;
}

interface DohJson {
  Status: number;
  AD?: boolean;
  Answer?: { name: string; type: number; data: string }[];
}

/** One TXT record's presentation data (`"chunk" "chunk"`) as the text it encodes. */
function unquoteTxt(data: string): string {
  return data.replace(/^"|"$/g, "").replace(/"\s+"/g, "");
}

/** A DNS name in comparable form: lowercase, without the trailing root dot. */
const canonName = (n: string) => n.toLowerCase().replace(/\.$/, "");

/** One DoH query. Throws when the resolver itself fails (HTTP error, timeout, no DNS answer). */
async function queryAt(url: string, name: string, type: RecordType): Promise<DohJson> {
  const res = await fetch(`${trimTrailingSlashes(url)}?name=${encodeURIComponent(name)}&type=${type}`, {
    headers: { accept: "application/dns-json" },
    signal: AbortSignal.timeout(RESOLVE_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`DNS resolver ${res.status}`);
  const ans = (await res.json()) as DohJson;
  if (typeof ans?.Status !== "number") throw new Error("DNS resolver sent no DNS answer");
  return ans;
}

/** Resolve `name` TXT through the DoH resolver at `url`. Throws when the resolver itself fails. */
export async function resolveTxtAt(url: string, name: string): Promise<TxtAnswer> {
  const ans = await queryAt(url, name, "TXT");
  const records = ans.Answer ?? [];
  const want = canonName(name);
  return {
    status: ans.Status,
    dnssec: ans.AD === true,
    txts: records.filter((a) => a.type === RECORD_TYPES.TXT).map((a) => unquoteTxt(a.data)),
    alias: records.some((a) => a.type === TYPE_CNAME || a.type === TYPE_DNAME),
    exact: records.every((a) => canonName(a.name) === want),
  };
}

/** Resolve `name` TXT through the configured validating resolver (`DOH_URL`). */
export function resolveTxt(env: Env, name: string): Promise<TxtAnswer> {
  return resolveTxtAt(env.DOH_URL || DEFAULT_DOH, name);
}

export interface DnsAnswer {
  /** DNS response code: 0 = answered, {@link NXDOMAIN} = no such name. */
  status: number;
  /** The resolver validated the answer with DNSSEC. */
  dnssec: boolean;
  /** The records of the asked type (an address, or a TXT record's joined text), aliases followed. */
  data: string[];
}

/**
 * Resolve `name` as `type` through the configured validating resolver (`DOH_URL`). The records of the asked
 * type are returned wherever a CNAME chain led: an address lookup wants where the name leads. Throws when
 * the resolver itself fails.
 */
export async function resolveRecord(env: Env, name: string, type: RecordType): Promise<DnsAnswer> {
  const ans = await queryAt(env.DOH_URL || DEFAULT_DOH, name, type);
  const want = RECORD_TYPES[type];
  return {
    status: ans.Status,
    dnssec: ans.AD === true,
    data: (ans.Answer ?? []).filter((a) => a.type === want).map((a) => (type === "TXT" ? unquoteTxt(a.data) : a.data)),
  };
}

/** The independent resolvers that must agree on an answer DNSSEC does not validate (`AMPR_DNS_RESOLVERS`). */
export function amprResolvers(env: Env): string[] {
  const list = (env.AMPR_DNS_RESOLVERS ?? "")
    .split(",")
    .map((u) => u.trim())
    .filter(Boolean);
  return list.length ? [...new Set(list)] : [...DEFAULT_AMPR_RESOLVERS];
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

/**
 * A base call's ARDC-delegated zone and the names under it: the federation identity record, the callsign
 * verification record, and the default name an instance runs at. The zone itself stays free for the ham's
 * other uses; no instance runs on it.
 */
export function amprNames(baseCall: string): { host: string; name: string; verify: string; instanceHost: string } {
  const host = `${baseCall.toLowerCase()}.ampr.org`;
  return {
    host,
    name: `_aprscaching.${host}`,
    verify: `_aprscaching-verify.${host}`,
    instanceHost: `aprscaching.${host}`,
  };
}
