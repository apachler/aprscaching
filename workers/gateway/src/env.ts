// SPDX-License-Identifier: AGPL-3.0-or-later
import type { SqlDatabase, ObjectStore, MediaStore, RoomNamespace } from "./runtime.js";

/**
 * Every string setting the gateway reads, in one list: the Env type is derived from it and the
 * self-host servers (Node, Bun, the desktop launcher) forward exactly these keys from the process
 * environment (stringEnvFrom). A setting added here is live on every runtime; one not listed here is
 * not a setting. Absent ⇒ the documented default (docs/reference/configuration.md).
 */
const ENV_STRING_KEYS = [
  // The operator's machine credential (x-operator-secret) for instance-wide configuration — operator
  // callsign verification, federation peer trust, FBB forwarding partners/rules — used by
  // tools/admin/* and scripts. Unset ⇒ those machine paths are closed; a signed-in, verified sysop
  // still administers the instance from the web.
  "OPERATOR_SECRET",
  // The session-signing secret. Required for sign-in: unset, weak ('change-me') or equal to
  // INGEST_SECRET/OPERATOR_SECRET ⇒ no session is minted or honoured. The Node/Bun servers generate
  // and persist one beside the database when it is not set in the environment.
  "SESSION_SECRET",
  // Server-side session lifetime in days (default 30) and an optional revocation epoch (unix
  // seconds): sessions minted before SESSION_EPOCH are rejected — rotate all sessions without
  // rotating secrets.
  "SESSION_TTL_DAYS",
  "SESSION_EPOCH",
  // "1" when a reverse proxy (Caddy, a Cloudflare Tunnel) fronts this instance — only then is
  // x-forwarded-for trusted for rate-limit keying.
  "TRUST_PROXY",
  // "1" when a Cloudflare edge (Tunnel or proxied DNS) fronts a Node/Bun instance — only then does a
  // `cf-connecting-ip` header survive into rate-limit keying. Set it only when the origin is reachable
  // solely through Cloudflare.
  "TRUST_CF",
  // Comma-separated licensed call(s) that may administer THIS instance (federation, forwarding
  // partners/rules, node routes, peer trust). Absent ⇒ no web sysop (admin endpoints locked;
  // OPERATOR_SECRET still reaches them from scripts). The role applies once the operator's account
  // holds that call and has control-verified it.
  "ADMIN_CALLSIGNS",

  // ---- federation — all optional; absent ⇒ feeds served unsigned ----
  "INSTANCE", // canonical instance id/domain, e.g. "oe.aprscaching.org"; default: APP_URL's hostname
  "FED_PRIVATE_KEY", // base64(JSON{pkcs8,pub}) Ed25519 CURRENT signing key; if set, records are signed
  "FED_KEY_HISTORY", // JSON [{x,since?,until?,revoked?}] of previous/extra public keys + revocations
  "FED_ROTATIONS", // JSON [{key,prevKey,at,sig}] rotation records — each new key vouched by the old
  "FED_ROTATION_GRACE_DAYS", // days a rotated-away key keeps verifying when its history entry has no `until` (default 7)
  "FED_REGISTRY", // signed registry doc {entries:[{instance,url?,key?,operator?,aprsCall?}],at,sig,signer}
  "FED_REGISTRY_KEY", // the registry authority's Ed25519 public key (base64url) used to verify FED_REGISTRY
  "FED_REGISTRY_DNS", // a DNS TXT record name carrying `url=…` of the signed registry (verified under FED_REGISTRY_KEY)
  "FED_OPERATOR", // this instance's operator label, self-published in /.well-known
  "FED_APRS_CALL", // this instance's APRS service callsign (<licensedCall>-<SERVICE_SSID>), self-published
  "FIRST_PARTY_SITES", // allowlist of IGate/site calls we operate + attest → Tier-A origin
  "FED_PEERS", // comma-separated peer base URLs, advertised in the descriptor
  "FED_DISCOVER", // if set, auto-add peers advertised by peers (transitive discovery)
  "FED_CORROBORATION_QUORUM", // distinct corroborating identities (registry operator, else signing key) required for Tier A (default 2)
  "FED_AUTO_PROMOTE", // confirmed-corroboration count to auto-promote an unvetted peer to trusted (0=off)
  "FED_CORROBORATION_SECRET", // if set, /federation/corroborate also requires x-fed-secret; askers send it only to trusted https peers
  "FED_CORROBORATION_REQUIRE_KNOWN", // "1": answer only askers that are known, non-blocked peers (by their verified key)
  "FED_REVEAL_IGATE", // if set, corroboration responses include the exact IGate (both peers opt in)
  "FED_SYNC_REGION", // S,W,N,E: pull only the caches inside this box from peers that filter by region (sync-cache-bbox)
  "FED_ENDPOINTS", // this instance's typed transport endpoints (JSON [{transport,address,priority}]) — published in the descriptor
  "FED_ALLOW_PRIVATE", // "1": federation may fetch private/loopback addresses (an all-LAN network); see fetchguard.ts
  // push-to-hub: NAT/firewall peers contribute without inbound reachability
  "FED_SUBMIT_SECRET", // HUB: if set, enables POST /federation/submit, gated by x-fed-secret. SPOKE: the secret it pushes with.
  "FED_SUBMIT_INSTANCES", // HUB: optional comma-separated allowlist of submitter instance ids (else any non-self)
  "FED_HUB_URL", // SPOKE: a reachable hub to push our signed records to (push-mode mirroring)
  "FED_RELAY_SECRET", // HUB+SPOKE: shared secret for the rendezvous relay; enables it when set

  // ---- retention of the diagnostic/telemetry tables (JSON; see retention.ts) ----
  "RETENTION",

  // ---- position storage: a fix is stored once its station moved or time passed (see downsample.ts) ----
  "POS_MIN_MOVE_M", // metres moved since the station's last stored fix (default 25; 0 stores every fix)
  "POS_MIN_INTERVAL_S", // seconds since the station's last stored fix (default 600; 0 stores every fix)
  // ---- the daily D1 write budget: sheds low-value writes as the day's count nears it (see budget.ts) ----
  "D1_DAILY_WRITE_BUDGET", // rows/day; Worker default 1500000 (free plan: 90000); Node/Bun: off unless set; 0 = off

  // ---- callsign verification ----
  "DOH_URL", // validating DNS-over-HTTPS resolver for 44net peer onboarding and the ampr.org DNSSEC check (default cloudflare-dns.com; must return the DNSSEC AD flag)
  "AMPR_DNS_RESOLVERS", // comma-separated independent DoH resolvers (JSON API) that must agree on an unsigned ampr.org answer (default Cloudflare, Google, Quad9)
  "AMPR_REQUIRE_DNSSEC", // "1": ampr.org callsign verification accepts only a DNSSEC-validated answer
  "LOTW_CA_PEM", // PEM certificate(s) of the ARRL LoTW CA(s) trusted for LoTW callsign verification; absent ⇒ that method is off

  // ---- imports — OpenCaching OKAPI ----
  "OKAPI_BASE", // e.g. https://www.opencaching.de
  "OKAPI_KEY", // free per-node consumer key (Level-1)

  // ---- BBS store-and-forward ----
  "BBS_CALL", // the relay callsign personal mail is delivered from, e.g. "OE8APR-5"; defaults to "APRSCG"
  "RADIO_REPLIES", // "1": text replies to FOUND/DNF/NOTE radio commands (HELP is always answered)

  // ---- public read API — free, per-IP rate-limited; free keys raise the cap ----
  "API_RATE_WINDOW_SEC", // rate-limit window seconds (default 60)
  "API_RATE_ANON", // anonymous requests/window (default 60)
  "API_RATE_KEYED", // with a free key: requests/window (default 600)

  // ---- live activity spots — read-only aggregation, off unless explicitly enabled ----
  "SPOTS_ENABLED", // "1"/"true" to enable outbound spot polling (default off: /api/spots → empty)
  "SPOTS_SOURCES", // optional comma-separated allowlist of sources (else all built-in: pota…)
  "SPOTS_TTL_SEC", // seconds between upstream polls (default 120); never shortens a source's own floor
  "SPOTS_USER_AGENT", // User-Agent sent to spot upstreams (default names APRScaching + the repo)
  "SPOTS_RECEPTION_URLS", // JSON {pskreporter?,dxcluster?,rbn?}: endpoints of the reception networks (each off unless set)

  // ---- the embeddable map widget (/embed) ----
  "BASEMAP_STYLE", // MapLibre style URL, or "offline" for the self-contained grid (default: OpenFreeMap liberty)
  "BASEMAP_HOSTS", // extra comma-separated origins the style loads tiles, glyphs or sprites from

  // ---- identity & auth — all optional; absent ⇒ dev mode (email token returned in-band) ----
  "APP_URL", // app origin for magic-link redirects, e.g. "https://aprscaching.net"
  "CORS_ORIGINS", // extra comma-separated origins allowed credentialed CORS (beyond APP_URL)
  "RP_ID", // WebAuthn relying-party id (registrable domain), e.g. "aprscaching.net"; default: APP_URL's hostname
  "EMAIL_FROM", // sender address for magic-link mail; absent ⇒ dev mode
  "EMAIL_API_KEY", // Resend-style API key; absent ⇒ dev mode (no real send)
  "ALLOW_DEV_TOKENS", // "1"/"true" to return magic-link tokens in-band when email is unconfigured (dev/CI only); off ⇒ a mail-less instance fails closed
  // "1": the operator's sign-in link (x-operator-secret) serves every call, not only ADMIN_CALLSIGNS, on
  // an instance that also offers passkeys or email — an off-grid station whose visitors have no other way
  // in. It widens what a leaked operator secret reaches to every account, so it is off by default.
  "OPERATOR_LINKS_FOR_ANY_CALL",

  // ---- push notifications — web push is off unless VAPID keys are set; email digest needs EMAIL_* ----
  "VAPID_PUBLIC", // VAPID public key (base64url, uncompressed P-256 point)
  "VAPID_PRIVATE", // VAPID private key 'd' (base64url)
  "VAPID_SUBJECT", // contact for the push service, e.g. "mailto:admin@aprscaching.net"

  // ---- supporter recognition — donation links surfaced on /support; recognition only ----
  "SUPPORT_LINKS", // JSON [{label,url}] in display order

  // ---- AGPL §13 source link and the operator's imprint ----
  "SOURCE_REPO", // repo URL; absent ⇒ upstream default. Self-hosters who MODIFY code MUST set this to their fork.
  "OPERATOR_NAME", // /imprint + /privacy: the person/entity operating THIS instance
  "OPERATOR_ADDRESS", // postal address, "," separates lines
  "OPERATOR_EMAIL", // reachable contact (also the privacy contact)
  "SOURCE_COMMIT", // commit (or tag) the instance is running; host-resolved at build/start
  "SOURCE_TAG", // optional release tag
  "SOURCE_BUILT_AT", // optional build unix-seconds
] as const;

/** Bindings the gateway needs, in runtime-neutral terms (see runtime.ts), plus every string setting. */
export type Env = {
  DB: SqlDatabase;
  TILES: ObjectStore;
  MEDIA?: MediaStore; // audio-cache clue storage (R2 on CF, FS on Node); optional
  ROOMS: RoomNamespace;
  // The ingest-plane credential: the ingest box presents it (x-ingest-secret) to post packets, drain the
  // outbox, deliver BBS mail, mirror the node table, log finds heard over APRS and poll remote commands.
  // It authorises nothing operator-level and never signs a session.
  INGEST_SECRET: string;
  /** Installed by Node/Bun: refuses federation fetches to private networks. Workers need none. */
  FED_FETCH_GUARD?: import("./fetchguard.js").FetchGuard;
  /** Installed by the Node server while its https listener runs: that listener's port (visitor.ts). */
  HTTPS_LISTENER_PORT?: string;
} & { [K in (typeof ENV_STRING_KEYS)[number]]?: string };

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
