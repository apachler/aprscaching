// SPDX-License-Identifier: AGPL-3.0-or-later
import type { SqlDatabase, ObjectStore, MediaStore, RoomNamespace } from "./runtime.js";

/** Bindings the gateway needs, in runtime-neutral terms (see runtime.ts). */
export interface Env {
  DB: SqlDatabase;
  TILES: ObjectStore;
  MEDIA?: MediaStore; // audio-cache clue storage (R2 on CF, FS on Node); optional
  ROOMS: RoomNamespace;
  // The ingest-plane credential: the ingest box presents it (x-ingest-secret) to post packets, drain the
  // outbox, deliver BBS mail, mirror the node table, log finds heard over APRS and poll remote commands.
  // It authorises nothing operator-level and never signs a session.
  INGEST_SECRET: string;
  // The operator's machine credential (x-operator-secret) for instance-wide configuration — operator
  // callsign verification, federation peer trust, FBB forwarding partners/rules — used by
  // tools/admin/* and scripts. Unset ⇒ those machine paths are closed; a signed-in, verified sysop
  // still administers the instance from the web.
  OPERATOR_SECRET?: string;
  // The session-signing secret. Required for sign-in: unset, weak ('change-me') or equal to
  // INGEST_SECRET/OPERATOR_SECRET ⇒ no session is minted or honoured. The Node/Bun servers generate
  // and persist one beside the database when it is not set in the environment.
  SESSION_SECRET?: string;
  // Server-side session lifetime in days (default 30) and an optional revocation epoch (unix
  // seconds): sessions minted before SESSION_EPOCH are rejected — rotate all sessions without
  // rotating secrets.
  SESSION_TTL_DAYS?: string;
  SESSION_EPOCH?: string;
  // "1" when a reverse proxy (Caddy, a Cloudflare Tunnel) fronts this instance — only then is
  // x-forwarded-for trusted for rate-limit keying.
  TRUST_PROXY?: string;
  // "1" when a Cloudflare edge (Tunnel or proxied DNS) fronts a Node/Bun instance — only
  // then does a `cf-connecting-ip` header survive into rate-limit keying. Set it only when the origin
  // is reachable solely through Cloudflare.
  TRUST_CF?: string;

  // ---- instance operator (sysop) — comma-separated licensed call(s) that may administer THIS instance
  // (federation, forwarding partners/rules, node routes, peer trust). Absent ⇒ no web sysop (admin
  // endpoints locked; OPERATOR_SECRET still reaches them from scripts). The operator lists their own call, and the
  // role applies once their account holds that call and has control-verified it.
  ADMIN_CALLSIGNS?: string;

  // ---- federation — all optional; absent => feeds served unsigned ----
  INSTANCE?: string; // canonical instance id/domain, e.g. "oe.aprscaching.org"; default: APP_URL's hostname
  FED_PRIVATE_KEY?: string; // base64(JSON{pkcs8,pub}) Ed25519 CURRENT signing key; if set, records are signed
  FED_KEY_HISTORY?: string; // JSON [{x,since?,until?,revoked?}] of previous/extra public keys + revocations
  FED_ROTATIONS?: string; // JSON [{key,prevKey,at,sig}] rotation records — each new key vouched by the old
  FED_ROTATION_GRACE_DAYS?: string; // days a peer's rotated-away key keeps verifying when its history entry has no `until` (default 7)
  // ---- signed instance registry / namespace authority — all optional ----
  FED_REGISTRY?: string; // signed registry doc {entries:[{instance,url?,key?,operator?,aprsCall?}],at,sig,signer}
  FED_REGISTRY_KEY?: string; // the registry authority's Ed25519 public key (base64url) used to verify FED_REGISTRY
  FED_REGISTRY_DNS?: string; // alt source: a DNS TXT record name carrying `url=…` of the signed registry (verified under FED_REGISTRY_KEY)
  FED_OPERATOR?: string; // this instance's operator label, self-published in /.well-known
  FED_APRS_CALL?: string; // this instance's APRS service callsign (<licensedCall>-<SERVICE_SSID>), self-published
  FIRST_PARTY_SITES?: string; // provenance seam: allowlist of IGate/site calls we operate + attest → Tier-A origin
  FED_PEERS?: string; // comma-separated peer base URLs, advertised in the descriptor
  FED_DISCOVER?: string; // if set, auto-add peers advertised by peers (transitive discovery)
  FED_CORROBORATION_QUORUM?: string; // distinct corroborating identities (registry operator, else signing key) required for Tier A (default 2)
  FED_AUTO_PROMOTE?: string; // confirmed-corroboration count to auto-promote an unvetted peer to trusted (0=off)
  PACKETS_TTL_HOURS?: string; // retention for the shack raw-packet ring (default 24)
  // ---- retention (days) for the diagnostic/telemetry tables (all optional) ----
  MESSAGES_TTL_DAYS?: string; // firehose message log (default 7)
  SENSOR_TTL_DAYS?: string; // weather/sensor readings (default 30)
  PORTSTATS_TTL_DAYS?: string; // per-port RX/TX counters (default 7)
  ALERTS_TTL_DAYS?: string; // seen watch-alerts (default 30)
  MHEARD_TTL_DAYS?: string; // NET/ROM node mheard rows (default 7)
  // ---- corroboration hardening + privacy coarsening — all optional ----
  FED_CORROBORATION_SECRET?: string; // if set, /federation/corroborate also requires x-fed-secret; askers send it only to trusted https peers
  FED_CORROBORATION_REQUIRE_KNOWN?: string; // "1": answer only askers that are known, non-blocked peers (by their verified key)
  FED_REVEAL_IGATE?: string; // if set, corroboration responses include the exact IGate (both peers opt in)
  FED_CORROBORATION_GRID_DEG?: string; // request center grid-snap size in degrees (default 0.005 ≈ 550 m)
  FED_CORROBORATION_TIME_BUCKET_SEC?: string; // request/response time bucket (default 600)
  FED_CORROBORATION_DIST_BUCKET_M?: string; // response distance bucket in metres (default 100)

  // ---- push-to-hub: NAT/firewall peers contribute without inbound reachability ----
  FED_SUBMIT_SECRET?: string; // HUB: if set, enables POST /federation/submit, gated by x-fed-secret. SPOKE: the secret it pushes with.
  FED_SUBMIT_INSTANCES?: string; // HUB: optional comma-separated allowlist of submitter instance ids (else any non-self)
  FED_HUB_URL?: string; // SPOKE: a reachable hub to push our signed records to (push-mode mirroring)
  FED_RELAY_SECRET?: string; // HUB+SPOKE: shared secret for the rendezvous relay; enables it when set

  // ---- imports — OpenCaching OKAPI ----
  OKAPI_BASE?: string; // e.g. https://www.opencaching.de
  OKAPI_KEY?: string; // free per-node consumer key (Level-1)

  // ---- BBS store-and-forward — the relay callsign personal mail is delivered from ----
  BBS_CALL?: string; // e.g. "OE8APR-5"; defaults to "APRSCG"
  RADIO_REPLIES?: string; // "1": text replies to FOUND/DNF/NOTE radio commands (HELP is always answered)

  // ---- public read API — free, per-IP rate-limited; free keys raise the cap ----
  API_RATE_WINDOW_SEC?: string; // rate-limit window seconds (default 60)
  API_RATE_ANON?: string; // anonymous requests/window (default 60)
  API_RATE_KEYED?: string; // with a free key: requests/window (default 600)
  API_MAX_BBOX_DEG?: string; // max bbox side in degrees for /api/v1 reads (default 20)

  // ---- live activity spots — read-only aggregation, off unless explicitly enabled ----
  FED_ALLOW_PRIVATE?: string; // "1": federation may fetch private/loopback addresses (an all-LAN network); see fetchguard.ts
  /** Installed by Node/Bun: refuses federation fetches to private networks. Workers need none. */
  FED_FETCH_GUARD?: import("./fetchguard.js").FetchGuard;
  FED_ENDPOINTS?: string; // this instance's typed transport endpoints (JSON array of {transport,address,priority}) — published in the descriptor
  DOH_URL?: string; // DNS-over-HTTPS resolver for 44net peer onboarding and ampr.org callsign verification (default cloudflare-dns.com; must return the DNSSEC AD flag)
  LOTW_CA_PEM?: string; // PEM certificate(s) of the ARRL LoTW CA(s) trusted for LoTW callsign verification; absent ⇒ that method is off
  COT_STREAM_INTERVAL_MS?: string; // SSE CoT feed poll cadence (default 15000; clamped 1s–2min)
  COT_STREAM_MAX_MS?: string; // SSE CoT feed max connection lifetime before the client reconnects (default 5min)
  SPOTS_ENABLED?: string; // "1"/"true" to enable outbound spot polling (default off: /api/spots → empty)
  SPOTS_SOURCES?: string; // optional comma-separated allowlist of sources (else all built-in: pota…)
  SPOTS_TTL_SEC?: string; // seconds between upstream polls (default 120); never shortens a source's own floor
  SPOTS_USER_AGENT?: string; // User-Agent sent to spot upstreams (default names APRScaching + the repo)
  SPOTS_POTA_URL?: string; // override the POTA activator-spots endpoint
  SPOTS_SOTA_URL?: string; // override the SOTA spots endpoint
  SPOTS_SOTA_SUMMITS_URL?: string; // SOTA summit-detail base (for coord resolution; default api-db2)
  SPOTS_GMA_URL?: string; // override the GMA/WWBOTA (cqgma.org) spots endpoint
  SPOTS_PSK_URL?: string; // PSKReporter reception-report JSON endpoint (reception net; off unless set)
  SPOTS_DXCLUSTER_URL?: string; // DX-cluster JSON endpoint (off unless set; mappable only with a grid)
  SPOTS_RBN_URL?: string; // RBN reception JSON endpoint (off unless set; mappable only with a grid)

  // ---- identity & auth — all optional; absent => dev mode (email token returned in-band) ----
  APP_URL?: string; // app origin for magic-link redirects, e.g. "https://aprscaching.net"
  CORS_ORIGINS?: string; // extra comma-separated origins allowed credentialed CORS (beyond APP_URL)
  RP_ID?: string; // WebAuthn relying-party id (registrable domain), e.g. "aprscaching.net"; default: APP_URL's hostname
  EMAIL_FROM?: string; // sender address for magic-link mail; absent => dev mode
  EMAIL_API_KEY?: string; // Resend-style API key; absent => dev mode (no real send)
  ALLOW_DEV_TOKENS?: string; // "1"/"true" to return magic-link tokens in-band when email is unconfigured
  // (dev/CI only). Off by default → a mail-less instance fails closed.

  // ---- push notifications — web push is off unless VAPID keys are set; email digest needs EMAIL_* ----
  VAPID_PUBLIC?: string; // VAPID public key (base64url, uncompressed P-256 point)
  VAPID_PRIVATE?: string; // VAPID private key 'd' (base64url)
  VAPID_SUBJECT?: string; // contact for the push service, e.g. "mailto:admin@aprscaching.net"

  // ---- supporter recognition — donation links surfaced on /support; recognition only ----
  SUPPORT_LIBERAPAY?: string;
  SUPPORT_KOFI?: string;
  SUPPORT_PATREON?: string;
  SUPPORT_GITHUB?: string;
  SUPPORT_OPENCOLLECTIVE?: string;

  // ---- AGPL §13 source link — the running instance's published source ----
  SOURCE_REPO?: string; // repo URL; absent => upstream default. Self-hosters who MODIFY code MUST set this to their fork.
  OPERATOR_NAME?: string; // /imprint + /privacy: the person/entity operating THIS instance
  OPERATOR_ADDRESS?: string; // postal address, "," separates lines
  OPERATOR_EMAIL?: string; // reachable contact (also the privacy contact)
  SOURCE_COMMIT?: string; // commit (or tag) the instance is running; host-resolved at build/start
  SOURCE_TAG?: string; // optional release tag
  SOURCE_BUILT_AT?: string; // optional build unix-seconds
}

/**
 * The canonical list of string-valued config keys the self-host servers (Node/Bun) forward from
 * `process.env` into `Env`. It covers every optional string field above — sysop admin, magic-link
 * email, push, rate limits, and first-party attestation are all live on self-host. Keep this in sync
 * with the optional string fields above — one source of truth for both runtimes.
 */
export const ENV_STRING_KEYS = [
  "OPERATOR_SECRET",
  "SESSION_SECRET",
  "SESSION_TTL_DAYS",
  "SESSION_EPOCH",
  "TRUST_PROXY",
  "TRUST_CF",
  "ADMIN_CALLSIGNS",
  "INSTANCE",
  "FED_PRIVATE_KEY",
  "FED_KEY_HISTORY",
  "FED_ROTATIONS",
  "FED_ROTATION_GRACE_DAYS",
  "FED_REGISTRY",
  "FED_REGISTRY_KEY",
  "FED_REGISTRY_DNS",
  "FED_OPERATOR",
  "FED_APRS_CALL",
  "FIRST_PARTY_SITES",
  "RADIO_REPLIES",
  "FED_PEERS",
  "FED_DISCOVER",
  "FED_CORROBORATION_QUORUM",
  "FED_AUTO_PROMOTE",
  "PACKETS_TTL_HOURS",
  "MESSAGES_TTL_DAYS",
  "SENSOR_TTL_DAYS",
  "PORTSTATS_TTL_DAYS",
  "ALERTS_TTL_DAYS",
  "MHEARD_TTL_DAYS",
  "FED_CORROBORATION_SECRET",
  "FED_CORROBORATION_REQUIRE_KNOWN",
  "FED_REVEAL_IGATE",
  "FED_CORROBORATION_GRID_DEG",
  "FED_CORROBORATION_TIME_BUCKET_SEC",
  "FED_CORROBORATION_DIST_BUCKET_M",
  "FED_SUBMIT_SECRET",
  "FED_SUBMIT_INSTANCES",
  "FED_HUB_URL",
  "FED_RELAY_SECRET",
  "OKAPI_BASE",
  "OKAPI_KEY",
  "BBS_CALL",
  "API_RATE_WINDOW_SEC",
  "API_RATE_ANON",
  "API_RATE_KEYED",
  "API_MAX_BBOX_DEG",
  "FED_ENDPOINTS",
  "FED_ALLOW_PRIVATE",
  "DOH_URL",
  "COT_STREAM_INTERVAL_MS",
  "COT_STREAM_MAX_MS",
  "SPOTS_ENABLED",
  "SPOTS_SOURCES",
  "SPOTS_TTL_SEC",
  "SPOTS_USER_AGENT",
  "SPOTS_POTA_URL",
  "SPOTS_SOTA_URL",
  "SPOTS_SOTA_SUMMITS_URL",
  "SPOTS_GMA_URL",
  "SPOTS_PSK_URL",
  "SPOTS_DXCLUSTER_URL",
  "SPOTS_RBN_URL",
  "APP_URL",
  "CORS_ORIGINS",
  "RP_ID",
  "EMAIL_FROM",
  "EMAIL_API_KEY",
  "ALLOW_DEV_TOKENS",
  "VAPID_PUBLIC",
  "VAPID_PRIVATE",
  "VAPID_SUBJECT",
  "SUPPORT_LIBERAPAY",
  "SUPPORT_KOFI",
  "SUPPORT_PATREON",
  "SUPPORT_GITHUB",
  "SUPPORT_OPENCOLLECTIVE",
  "SOURCE_REPO",
  "OPERATOR_NAME",
  "OPERATOR_ADDRESS",
  "OPERATOR_EMAIL",
  "SOURCE_COMMIT",
  "SOURCE_TAG",
  "SOURCE_BUILT_AT",
] as const satisfies ReadonlyArray<keyof Env>;

/** Build the string-config slice of Env from a process.env-like record (undefined keys omitted). */
export function stringEnvFrom(src: Record<string, string | undefined>): Partial<Env> {
  const out: Record<string, string> = {};
  for (const k of ENV_STRING_KEYS) {
    const v = src[k];
    if (v !== undefined) out[k] = v;
  }
  return out as Partial<Env>;
}

const blank = (v: string | undefined): boolean => typeof v !== "string" || v.trim() === "";

/**
 * Fill the settings that follow from APP_URL: INSTANCE and RP_ID default to its hostname, so an operator
 * configures one public URL instead of three strings that must agree. An explicit value always wins; a
 * blank one (compose passes `${VAR:-}`) counts as unset. Without a parseable APP_URL both stay unset,
 * which keeps their own fallbacks (the request host; passkeys closed). Idempotent: it fills `env` in place
 * so per-env caches keyed on the object stay valid, and returns it.
 */
export function applyDerivedDefaults(env: Env): Env {
  if (!blank(env.INSTANCE) && !blank(env.RP_ID)) return env;
  let host: string | null;
  try {
    host = blank(env.APP_URL) ? null : new URL(env.APP_URL as string).hostname || null;
  } catch {
    host = null;
  }
  if (blank(env.INSTANCE)) env.INSTANCE = host ?? undefined;
  if (blank(env.RP_ID)) env.RP_ID = host ?? undefined;
  return env;
}
