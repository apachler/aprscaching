// SPDX-License-Identifier: MIT
/**
 * Canonical JSON + the authorship message, shared by every party that must agree byte-for-byte:
 * the web (signs), the gateway (verifies), and federation consumers (re-verify). Keep this tiny
 * and dependency-free.
 */
export function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`)
    .join(",")}}`;
}

/** The exact bytes a logger signs to attest authorship of a find. v1 fields are fixed + ordered. */
export interface Authorship {
  cache: string; // cache code (AC-####)
  instance: string; // home instance id (disambiguates the cache network-wide)
  logger: string; // logger callsign (UPPER)
  logType: string; // "found" | ...
  at: number; // client authorship time (epoch seconds)
}
/**
 * Domain prefixes for standalone signed JSON documents: the signed bytes are the prefix followed by
 * the canonical message, so a signature made for one purpose can never be presented for another.
 * Verifiers accept only the prefixed form.
 */
export const SIG_DOMAIN = {
  rotation: "acs-rot/1\n",
  registry: "acs-reg/1\n",
  ingest: "acs-ing/1\n",
  box: "acs-box/1\n",
  boxEnroll: "acs-box-enroll/1\n",
} as const;

export function authorshipMessage(a: Authorship): string {
  return stableStringify({
    v: 1,
    cache: a.cache,
    instance: a.instance,
    logger: a.logger,
    logType: a.logType,
    at: a.at,
  });
}

/**
 * The exact bytes signed to authorize a sensitive account action (data export, erasure, or a
 * migration to another instance). Signed by a device key already registered to the callsign;
 * `instance` binds it to where the action runs (the *target* instance for a migration).
 */
export function accountActionMessage(a: { action: string; callsign: string; instance: string; at: number }): string {
  return stableStringify({
    v: 1,
    action: a.action,
    callsign: a.callsign.toUpperCase(),
    instance: a.instance,
    at: a.at,
  });
}

/**
 * The exact bytes a browser RF station signs to push an ingest batch to a public gateway without the
 * shared ingest secret. Binds the operator's callsign, a freshness timestamp, and the
 * batch count + digest of the canonical packets, so a signature can't be replayed for other content.
 * The gateway verifies the signature against a key registered to `callsign` (callsign_keys).
 */
/**
 * What an enrolled ingest box signs on each request to its gateway: the method, the path with its query,
 * the time (unix seconds), a random nonce and the SHA-256 of the body. Any change to one of them breaks the
 * signature, and the gateway accepts each signature once.
 */
export function boxRequestMessage(a: {
  box: string;
  method: string;
  path: string;
  at: number;
  nonce: string;
  digest: string;
}): string {
  return stableStringify({
    v: 1,
    kind: "box-request",
    box: a.box,
    method: a.method.toUpperCase(),
    path: a.path,
    at: a.at,
    nonce: a.nonce,
    digest: a.digest,
  });
}

/** What a box signs when it enrolls with a one-time code: proof that it holds the key it registers. */
export function boxEnrollMessage(a: { box: string; key: string; code: string; at: number }): string {
  return stableStringify({ v: 1, kind: "box-enroll", box: a.box, key: a.key, code: a.code, at: a.at });
}

export function ingestMessage(a: { callsign: string; at: number; count: number; digest: string }): string {
  return stableStringify({
    v: 1,
    kind: "ingest",
    callsign: a.callsign.toUpperCase(),
    at: a.at,
    count: a.count,
    digest: a.digest,
  });
}

/** SHA-256 of a string as lowercase hex (WebCrypto — browser, Worker, Node 20+). For ingest digests. */
export async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
