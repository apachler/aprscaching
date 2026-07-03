// SPDX-License-Identifier: AGPL-3.0-or-later
import type { SqlDatabase, ObjectStore, MediaStore, RoomNamespace } from "./runtime.js";

/** Bindings the gateway needs, in runtime-neutral terms (see runtime.ts). */
export interface Env {
  DB: SqlDatabase;
  TILES: ObjectStore;
  MEDIA?: MediaStore;       // audio-cache clue storage (R2 on CF, FS on Node); optional
  ROOMS: RoomNamespace;
  INGEST_SECRET: string;
  // Dedicated session-signing secret (SR-SEC-01). Optional: absent ⇒ derived from INGEST_SECRET
  // (single-operator self-host convenience) — but that couples the ingest-box credential to user
  // sessions, so shared gateways SHOULD set it. Sessions are refused entirely while the effective
  // secret is unset/'change-me' (auth.ts weakSecret): a default deploy can never mint a forgeable
  // admin cookie.
  SESSION_SECRET?: string;

  // ---- instance operator (sysop) — comma-separated licensed call(s) that may administer THIS instance
  // (federation, forwarding partners/rules, node routes, peer trust). Absent ⇒ no web sysop (admin
  // endpoints locked; the ingest still uses INGEST_SECRET). The operator sets their own signed-in call.
  ADMIN_CALLSIGNS?: string;

  // ---- federation (F1) — all optional; absent => feeds served unsigned ----
  INSTANCE?: string;        // canonical instance id/domain, e.g. "oe.aprscaching.org"
  FED_PRIVATE_KEY?: string; // base64(JSON{pkcs8,pub}) Ed25519 CURRENT signing key; if set, records are signed
  FED_KEY_HISTORY?: string; // JSON [{x,since?,until?,revoked?}] of previous/extra public keys + revocations (T4.1)
  FED_ROTATIONS?: string;   // JSON [{key,prevKey,at,sig}] rotation records — each new key vouched by the old (T4.1)
  // ---- signed instance registry / namespace authority (T4.2) — all optional ----
  FED_REGISTRY?: string;     // signed registry doc {entries:[{instance,url?,key?,operator?,aprsCall?}],at,sig,signer}
  FED_REGISTRY_KEY?: string; // the registry authority's Ed25519 public key (base64url) used to verify FED_REGISTRY
  FED_REGISTRY_DNS?: string; // alt source (T4.2): a DNS TXT record name carrying `url=…;key=…` to the signed registry
  FED_OPERATOR?: string;     // this instance's operator label, self-published in /.well-known
  FED_APRS_CALL?: string;    // this instance's APRS service callsign (<licensedCall>-<SERVICE_SSID>), self-published
  FED_AMATEUR_ENDPOINT?: string; // reserved: optional 44net/HAMNET addr or ampr.org host; reachability only, trust-neutral
  FIRST_PARTY_SITES?: string;    // provenance seam: allowlist of IGate/site calls we operate + attest → Tier-A origin
  FED_PEERS?: string;       // comma-separated peer base URLs, advertised in the descriptor
  FED_DISCOVER?: string;    // if set, auto-add peers advertised by peers (transitive discovery)
  FED_CORROBORATION_QUORUM?: string; // distinct instances required to upgrade a find to Tier A (F4/T1.2; default 1)
  FED_AUTO_PROMOTE?: string;         // confirmed-corroboration count to auto-promote an unvetted peer to trusted (T1.1; 0=off)
  TOMBSTONE_TTL_DAYS?: string;       // retention for delete tombstones before GC (F4/T1.3; default 180)
  PACKETS_TTL_HOURS?: string;        // retention for the workbench raw-packet ring (Stage 0.2; default 24)
  // ---- corroboration hardening + privacy coarsening (F4/T1.2) — all optional ----
  FED_CORROBORATION_SECRET?: string;        // if set, /federation/corroborate requires x-fed-secret (peer allowlist)
  FED_REVEAL_IGATE?: string;                // if set, corroboration responses include the exact IGate (both peers opt in)
  FED_CORROBORATION_GRID_DEG?: string;      // request center grid-snap size in degrees (default 0.005 ≈ 550 m)
  FED_CORROBORATION_TIME_BUCKET_SEC?: string; // request/response time bucket (default 600)
  FED_CORROBORATION_DIST_BUCKET_M?: string; // response distance bucket in metres (default 100)

  // ---- push-to-hub: NAT/firewall peers contribute without inbound reachability (F5/T2.3) ----
  FED_SUBMIT_SECRET?: string;    // HUB: if set, enables POST /federation/submit, gated by x-fed-secret. SPOKE: the secret it pushes with.
  FED_SUBMIT_INSTANCES?: string; // HUB: optional comma-separated allowlist of submitter instance ids (else any non-self)
  FED_HUB_URL?: string;          // SPOKE: a reachable hub to push our signed records to (push-mode mirroring)
  FED_RELAY_SECRET?: string;     // HUB+SPOKE: shared secret for the rendezvous relay (T2.3 path 2); enables it when set

  // ---- imports (M3) — OpenCaching OKAPI ----
  OKAPI_BASE?: string;      // e.g. https://www.opencaching.de
  OKAPI_KEY?: string;       // free per-node consumer key (Level-1)

  // ---- BBS store-and-forward — the relay callsign personal mail is delivered from ----
  BBS_CALL?: string;        // e.g. "OE8APR-5"; defaults to "APRSCG"

  // ---- public read API — free, per-IP rate-limited; free keys raise the cap ----
  API_RATE_WINDOW_SEC?: string; // rate-limit window seconds (default 60)
  API_RATE_ANON?: string;       // anonymous requests/window (default 60)
  API_RATE_KEYED?: string;      // with a free key: requests/window (default 600)
  API_MAX_BBOX_DEG?: string;    // max bbox side in degrees for /api/v1 reads (default 20)

  // ---- live activity spots — read-only aggregation, off unless explicitly enabled ----
  SPOTS_ENABLED?: string;   // "1"/"true" to enable outbound spot polling (default off: /api/spots → empty)
  SPOTS_SOURCES?: string;   // optional comma-separated allowlist of sources (else all built-in: pota…)
  SPOTS_TTL_SEC?: string;   // aggregation cache TTL seconds (default 60; spots are ephemeral)
  SPOTS_POTA_URL?: string;  // override the POTA activator-spots endpoint
  SPOTS_SOTA_URL?: string;  // override the SOTA spots endpoint
  SPOTS_SOTA_SUMMITS_URL?: string; // SOTA summit-detail base (for coord resolution; default api-db2)
  SPOTS_GMA_URL?: string;   // override the GMA/WWBOTA (cqgma.org) spots endpoint
  SPOTS_PSK_URL?: string;   // PSKReporter reception-report JSON endpoint (reception net; off unless set)
  SPOTS_DXCLUSTER_URL?: string; // DX-cluster JSON endpoint (off unless set; mappable only with a grid)
  SPOTS_RBN_URL?: string;   // RBN reception JSON endpoint (off unless set; mappable only with a grid)

  // ---- M9 identity & auth — all optional; absent => dev mode (email token returned in-band) ----
  APP_URL?: string;         // app origin for magic-link redirects, e.g. "https://aprscaching.com"
  RP_ID?: string;           // WebAuthn relying-party id (registrable domain), e.g. "aprscaching.com"
  EMAIL_FROM?: string;      // sender address for magic-link mail; absent => dev mode
  EMAIL_API_KEY?: string;   // Resend-style API key; absent => dev mode (no real send)
  ALLOW_DEV_TOKENS?: string; // "1"/"true" to return magic-link tokens in-band when email is unconfigured
                             // (dev/CI only). Off by default → a mail-less instance fails closed (SR-SEC-06).

  // ---- push notifications (ADR-4b) — web push is off unless VAPID keys are set; email digest needs EMAIL_* ----
  VAPID_PUBLIC?: string;    // VAPID public key (base64url, uncompressed P-256 point)
  VAPID_PRIVATE?: string;   // VAPID private key 'd' (base64url)
  VAPID_SUBJECT?: string;   // contact for the push service, e.g. "mailto:admin@aprscaching.net"

  // ---- supporter recognition — donation links surfaced on /support; recognition only ----
  SUPPORT_LIBERAPAY?: string; SUPPORT_KOFI?: string; SUPPORT_PATREON?: string;
  SUPPORT_GITHUB?: string; SUPPORT_OPENCOLLECTIVE?: string;

  // ---- AGPL §13 source link (ADR-3) — the running instance's published source ----
  SOURCE_REPO?: string;     // repo URL; absent => upstream default. Self-hosters who MODIFY code MUST set this to their fork.
  SOURCE_COMMIT?: string;   // commit (or tag) the instance is running; host-resolved at build/start
  SOURCE_TAG?: string;      // optional release tag
  SOURCE_BUILT_AT?: string; // optional build unix-seconds
}
