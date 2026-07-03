# STABILITY-REVIEW.md — aprscaching 1.0.0 reliability & security audit

> Living document. Static analysis for **24/7 unattended operation** (Raspberry Pi / OCI free-tier,
> weeks-to-months uptime, hostile RF + hostile HTTP/federation peers). Findings carry stable IDs
> (`SR-<AREA>-NN`) and checkboxes; tick them as fixes land. Severity: **Critical** (data loss,
> remote crash, trust-model breach, account takeover) · **High** · **Medium** · **Low**.
>
> Method: seven parallel deep-reads of the hot subsystems; the highest-stakes Critical/High claims
> were re-verified line-by-line against source before inclusion (marked ✓verified). Baseline at audit
> time: `pnpm -r build` + `pnpm -r test` green; 79 unit-test files across the workspace.

## Production Readiness Score: 58 → 88 / 100

> **Update 2 (2026-07-03, P1 batch) — the entire go-public P1 set from HAPPY-CODING.md is fixed**,
> each with tests: SR-SEC-08/09/10/11/12/13 (timing-safe compares · durable un-spoofable rate
> limiting + migration 0007 · ingest caps · server-side session expiry/epoch · register/finish-only
> accounts · WebAuthn fail-closed), SR-FED-07/08/09/10/11 (quorum + matched-evidence reputation —
> the F4 launch gate · monotonic mirror upserts · ingest ts clamp + browser-rf TTL + bounded verify
> window · tombstones retained indefinitely · rlBuckets sweep), SR-RT-07/10/11 (indexed + batched
> TTL via migration 0006 · Node body cap · process failure/SIGTERM handlers on Node+Bun). The
> toolchain was also modernized (pnpm 11 + supply-chain floor, Node 24 CI, TS 6, vitest 4,
> wrangler 4, better-sqlite3 12, React 19, MapLibre 5, zod 4, Vite 8) — all CI-green.
>
> **Update 1 — all 8 Criticals AND all 27 High findings fixed**, each with a regression test;
> ticked in the detail sections below. Remaining open items (P2/P3 Mediums + Lows) stay tracked in
> `HAPPY-CODING.md` — this document is the record of *what was found*, HAPPY-CODING.md of *what is
> left to do*.
>
> Green across `pnpm -r build`, `pnpm -r test` (230+ tests incl. the new P1 suites), the Node/SQLite
> smoke + geofence conformance, and the two-instance federation e2e (92 assertions). Schema:
> migrations 0005–0007. The repo is professionalized for going public (community-health files,
> hardened + SHA-pinned CI, CodeQL, Dependabot, DCO, release-please, ESLint+Prettier enforced).
>
> Score 88: the remaining gap is the two deep-read passes still **PENDING** (`SR-WEB-*`, `SR-CFG-*`),
> the open P2/P3 Mediums/Lows, and owned-RF Tier A / hardware validation, which genuinely need a
> live site. Neither pending pass has surfaced a Critical; both are scoped in HAPPY-CODING.md.

Justification: the *architecture* is genuinely strong — a single shared gateway app across three
runtimes, a transport-blind trust engine, signed authorship/federation, a real DO-hibernation live
layer, and defensively-coded text parsers with broad test coverage. But it is **not yet fit to run
unattended or face the public internet**, and several defects sit squarely on the launch-blocking
invariants:

- **Trust model (−18):** the two enforcement legs the README advertises for Tier A — *independent
  IGate* and *plausible track* — are respectively a no-op (`loggerOwnIgates: new Set()`) and absent;
  Tier B never checks the app-reading's freshness. A single motivated user can mint A or B. The
  transport≠trust rule itself holds (a bare IS packet cannot reach B), but the corroboration legs do not.
- **Federation (−12):** signatures cover `{type,id,data}` but not `signer`/namespace, so any synced
  or submitting peer can impersonate a trusted instance, overwrite its mirrored records, tombstone-
  censor arbitrary global IDs, and hijack account-move pointers; peer keys are re-pinned every sync
  with no rotation-proof check. F4 trust is explicitly launch-gating and is not yet enforced.
- **Security (−14):** the committed `INGEST_SECRET = "change-me"` default doubles as the session-
  signing key with no boot guard → default deploys have a forgeable admin session; unauthenticated
  device-key registration enables account-delete spoofing; reflected XSS in `/embed`; the APRS
  verification code is brute-forceable; the magic-link token is returned in-band when email is unset.
- **24/7 resilience (−10):** the APRS-IS/IGate/uplink reconnect fires twice per failure (connection
  storm), a silently-dead uplink is never detected, a gateway outage or rotated secret loses data
  invisibly, several always-growing tables have no TTL in any runtime, and the Node/Bun TTL job never
  runs if the box reboots more often than daily.
- **Remote crash surface (−6):** a post-`FQ` FBB line and a truncated Meshtastic `fixed32` are each a
  single-packet remote crash of the ingest/link.

None of these are architectural; all are local, testable fixes. With the Critical/High set addressed
the score rises to an estimated **82–85** (remaining gap = owned-RF Tier A, hardware validation, and
the deferred F4 quorum work that genuinely needs a live peer).

---

## Severity index

| ID | Sev | Area | One-line |
|----|-----|------|----------|
| SR-TRUST-01 | Critical | verify | Tier A self-corroboration: logger's own IGate never excluded (`new Set()`) ✓verified |
| SR-SEC-01 | Critical | security | `INGEST_SECRET="change-me"` default *is* the session key; no boot guard → forgeable admin ✓verified |
| SR-SEC-02 | Critical | security/trust | Unauthenticated `/keys/register` → account-delete spoofing & callsign impersonation ✓verified |
| SR-FED-01 | Critical | federation | Record `signer`/`id` outside the signature → origin spoof + mirror overwrite ✓verified |
| SR-FED-02 | Critical | federation | Tombstones purge arbitrary targets (no origin↔target namespace check) |
| SR-PKT-01 | Critical | packet | FBB session crashes on any line after `FQ` → remote process kill |
| SR-ING-01 | Critical | ingest | APRS-IS reconnect fires on both `error`+`close` → connection storm + dup packets ✓verified |
| SR-PARSE-01 | Critical | aprs | Meshtastic `fixed32` reader: OOB crash + silent cross-frame coordinate read |
| SR-TRUST-02 | High | verify | "Plausible track" advertised but not implemented — no speed/teleport check ✓verified |
| SR-TRUST-03 | High | verify | Tier B accepts client `appGeo` whose timestamp is never checked ✓verified |
| SR-SEC-03 | High | security | Reflected XSS in `/embed` via `bbox`/`cache` breaking out of inline `<script>` ✓verified |
| SR-SEC-04 | High | security | Box remote-control IDOR — any user can enqueue TX to any operator's box |
| SR-SEC-05 | High | security | Forgeable account-migration bundle → import any callsign as "verified" |
| SR-SEC-06 | High | security | Magic-link token returned in HTTP response when email unconfigured |
| SR-SEC-07 | High | security | APRS verification code brute-forceable (unauth, unthrottled, `Math.random`) |
| SR-FED-03 | High | federation | `/federation/submit` lets any secret-holder impersonate any instance + self-mint `trusted` |
| SR-FED-04 | High | federation | Peer key blindly re-pinned every sync; rotation proofs never verified |
| SR-FED-05 | High | federation | Account-move records unauthenticated + attacker-chosen timestamps |
| SR-FED-06 | High | federation | Sync fetches have no timeout — one hung peer stalls the whole scheduled loop |
| SR-ING-02 | High | ingest | No stale-connection detection — a silently dead APRS-IS uplink is never noticed |
| SR-ING-03 | High | ingest | Gateway outage → every batch permanently dropped (no retry, no bounded queue) |
| SR-ING-04 | High | ingest | HTTP error responses treated as success — silent data loss, zero logs |
| SR-ING-05 | High | ingest | FBB connect-timeout leaks the KISS TCP socket + a 1 s timer per attempt |
| SR-PKT-02 | High | packet | Malformed/short FS reply silently marks unsent mail as forwarded (mail loss) |
| SR-PKT-03 | High | packet | Messages marked "sent" at byte-gen; timeout still reconciles `markSent` (partial-transfer loss) |
| SR-PKT-04 | High | packet/ax25 | SABME connect retries with plain SABM → mod-128 modulus mismatch |
| SR-PKT-05 | High | packet | SessionServer accepts SABME but decodes frames as mod-8 → REJ-storm livelock |
| SR-PKT-06 | High | packet | NET/ROM circuits have no timers: one lost packet wedges the circuit forever |
| SR-PKT-07 | High | packet | FBB scheduler: `link.connect()` has no timeout → partner busy forever |
| SR-RT-01 | High | runtime | Worker `scheduled()` ignores which cron fired → full nightly job runs every 15 min ✓verified |
| SR-RT-02 | High | runtime | Node/Bun TTL job never runs if the process restarts within 24 h |
| SR-RT-03 | High | runtime | Servers don't plumb large parts of `Env` (Bun can never have a sysop) |
| SR-RT-04 | High | runtime | DO `webSocketMessage` crashes on any malformed/binary client frame |
| SR-RT-05 | High | runtime | Always-growing tables (`messages`, `sensor_readings`, `port_stats`, `watch_alerts`…) have no TTL |
| SR-RT-06 | High | runtime | Node rooms: no WS heartbeat/backpressure cap → dead client buffers firehose to OOM |
| SR-PARSE-02 | High | aprs | AFSK HDLC receiver grows an unbounded bit array on noise/crafted audio |
| SR-SEC-08 | Medium | security | Non-timing-safe secret comparisons everywhere (`===`) |
| SR-SEC-09 | Medium | security | Rate limiting is in-memory-per-isolate and keyed on spoofable IP headers |
| SR-SEC-10 | Medium | security | Ingest batch has no array-length or body-size cap (memory/DB DoS) |
| SR-SEC-11 | Medium | security | Session tokens never expire server-side (timestamp signed but ignored) ✓verified |
| SR-SEC-12 | Medium | security | Unauthenticated account squatting via `passkey/register/begin` |
| SR-SEC-13 | Medium | security | WebAuthn origin/rpId fall back to attacker-controlled `Origin` header |
| SR-FED-07 | Medium | federation | Auto-promotion farmable; corroboration quorum defaults to 1 |
| SR-FED-08 | Medium | federation | Mirror upserts have no version monotonicity — stale-record replay rolls mirrors back |
| SR-FED-09 | Medium | federation | Browser-signed ingest: unvalidated packet `ts`; `browser-rf` positions never TTL-pruned |
| SR-TRUST-04 | Medium | verify | No idempotency on find logging — concurrent/replayed POSTs duplicate verified finds |
| SR-FED-10 | Medium | federation | Tombstone TTL (180 d) lets GDPR-deleted records be resurrected |
| SR-FED-11 | Medium | federation | `rlBuckets` rate-limit map grows unbounded in long-lived runtimes |
| SR-RT-07 | Medium | runtime | TTL delete on `positions` has no usable index → full scan (sync-blocking on Node) |
| SR-RT-08 | Medium | runtime | D1 shims accept `undefined` binds that real D1 rejects (parity break) |
| SR-RT-09 | Medium | runtime | Shim `meta` zeroed for row-returning statements (latent `RETURNING` parity break) |
| SR-RT-10 | Medium | runtime | Node HTTP bridge buffers request bodies with no size limit (OOM DoS) |
| SR-RT-11 | Medium | runtime | No `unhandledRejection`/`uncaughtException`/SIGTERM handling in Node/Bun |
| SR-PKT-08 | Medium | packet | SessionServer warming slot never expires — hung factory blocks caller + eats a slot |
| SR-PKT-09 | Medium | packet | TerminalSession: unbounded auto-accepted channels + unbounded scrollback |
| SR-PKT-10 | Medium | packet | NODES route table unbounded by default + poisonable by forged broadcasts |
| SR-PKT-11 | Medium | packet | Hostile-peer OOM: RX line buffers + BBS/FBB bodies unbounded |
| SR-PKT-12 | Medium | packet | NetromCircuit accepts ConnReq in any state (hijack); window=0 ConnAck wedges sender |
| SR-PKT-13 | Medium | packet | CachedBbsStore confirms "stored" then discards on backend write failure |
| SR-PKT-14 | Medium | packet | `hasBid()` stubbed false defeats FBB loop-suppression → bodies retransmit every cycle |
| SR-ING-06 | Medium | ingest | No exponential backoff/jitter on any transport (fixed 3 s) |
| SR-ING-07 | Medium | ingest | Outbox acked after a write that may only have buffered on a dead socket |
| SR-ING-08 | Medium | ingest | KISS RX buffer grows unbounded on a non-KISS stream; survives reconnects |
| SR-CFG-01 | Medium | config | 26 ingest env vars read in code but absent from `.env.example` (see SR-CFG table) |
| SR-CFG-02 | Medium | config | Numeric env values unvalidated — `BATCH_MS=` → ~1 ms flush loop; bad ports dial 0 |
| SR-CFG-03 | Medium | config | Documented `pnpm dev` path never loads `.env` → silently runs as `N0CALL`/`change-me` |
| SR-PARSE-03 | Medium | aprs | Object/Item with unparseable position silently emitted at 0,0 (null island) |
| SR-PARSE-04 | Medium | aprs | Position encoder can emit invalid minutes `60.00` |
| SR-PARSE-05 | Medium | aprs | Inbound CoT recompiles a RegExp per attribute per event (GC churn) |
| SR-SEC-14 | Low | security | Unauth `startAprsChallenge` → outbound APRS spam |
| SR-SEC-15 | Low | security | Reflective CORS echoes any origin with credentials (SameSite-mitigated today) |
| SR-FED-12 | Low | federation | Relay lease/answer not bound to requesting spoke |
| SR-FED-13 | Low | federation | Failed signing-key load memoized as `null` forever → instance serves unsigned feeds |
| SR-PKT-15 | Low | packet/ax25 | Peer SABM on established link resets it silently — L3 never told |
| SR-ING-09 | Low | ingest | "Heard" maps (`igate`, `netromnode`) never evicted — slow unbounded growth |
| SR-ING-10 | Low | ingest | Outbox poll failures swallowed forever with zero logging |
| SR-ING-11 | Low | ingest | UDP/CoT listeners die permanently on bind error with a single log line |
| SR-ING-12 | Low | ingest | Serial PTT has no `error` listener — USB unplug crashes the process (module unwired) |
| SR-RT-12 | Low | runtime | `handleSetStages` orphans media objects; FS media store traversal-safe only via URL normalization |
| SR-RT-13 | Low | runtime | DO `webSocketClose` no-op close + missing `webSocketError` handler |
| SR-RT-14 | Low | runtime | Bun rooms drop live messages under backpressure; fed sync double-scheduled |
| SR-PARSE-06 | Low | aprs | MGRS band letter wrong for latitudes 80–84° (display-only) |
| SR-WEB-* | — | web | (pending — final agent) |
| SR-CFG-* | — | config/obs | (env-drift table + observability + deploy — final agent) |

---

## Detail — Trust engine (`verify.ts`, `caches.ts`, `corroborate.ts`)

The trust engine is server-side and transport-blind (Tier A branches only on `firstPartyAttested`,
browser ingest strips the IGate, no code path lifts a bare IS packet to B). The breaches are in the
*corroboration legs*, not the transport rule.

- [x] **SR-TRUST-01 (Critical) — Tier A self-corroboration.** `caches.ts:372` calls `verifyFind`
  with `loggerOwnIgates: new Set()` (always empty), and `verify.ts:93-95` only skips a fix when
  `deps.loggerOwnIgates?.has(ig)`. With no `FIRST_PARTY_SITES` set (launch default), `provenanceOf`
  gives `siteOk = !!igate`, so any RF-heard beacon with any gating IGate is `firstPartyAttested`. A
  cacher who runs their own IGate can beacon a spoofed position *at the cache*, gate it themselves,
  and self-mint **Tier A** — the exact "self-gated ⇒ not corroborated" case the comment claims to
  block. *Fix:* derive `loggerOwnIgates = new Set([baseCall(loggerCall), ...account_stations])` and
  compare by base call in `tryRf`/`tryLiving`, mirroring `corroborate.ts:localCorroboration`. *Test:*
  position `OE8APR-9` gated by `OE8APR-10` (both the logger's) → assert tier ≠ A. **Touches trust
  model — confirm before implementing.**
- [x] **SR-TRUST-02 (High) — "plausible track" is not implemented.** `verify.ts:89-103` (`tryRf`) is
  only `firstPartyAttested` + haversine radius; there is no inter-fix speed/teleport/consistency
  check anywhere (`speed_kn` is stored in `positions` but never read). The README's third A-tier leg
  does not exist, so one forged beacon near the cache mints A. *Fix:* reject a matched fix whose
  implied speed from neighbouring same-callsign fixes exceeds a bound (~300 km/h) and require ≥2
  consistent fixes for A. *Test:* two fixes 1000 km / 60 s apart, second at the cache → tier ≠ A.
  **Touches trust model — confirm before implementing.**
- [x] **SR-TRUST-03 (High) — Tier B ignores `appGeo.ts`.** `verify.ts:127-136` (`tryApp`) never reads
  the required `ts` field; `accuracyM` is attacker-chosen JSON. Tier B is the default `minTier`, so
  any signed-in user can replay a days-old/fabricated reading at the cache coords and reach verified-B
  without being present. *Fix:* reject when `abs(now − appGeo.ts) > ~120 s` (pass `now` in) and clamp
  `accuracyM`. *Test:* log with `appGeo.ts = now − 86400` → tier ≠ B. **Touches trust model — confirm.**
- [x] **SR-TRUST-04 (Medium) — no find-log idempotency.** `cache_logs` has no unique constraint
  (`0001_core.sql:62-76`) and `handleLog` does no already-found check; racing/replayed POSTs both run
  verify + insert + owner-alert + announce + gossip. *Fix:* partial unique index
  `ON cache_logs(cache_id, logger_call) WHERE log_type='found'`; return the existing log on conflict.

## Detail — Security surface (gateway HTTP/WS + crypto + tools)

- [x] **SR-SEC-01 (Critical) — `change-me` default is the session key, no boot guard.** `wrangler.toml:35`
  ships `INGEST_SECRET = "change-me"` as a plaintext `[vars]` default; `servers/{node,bun}/src/server.ts:30`
  default to `"change-me"`; and `auth.ts:248` derives the session HMAC key from `env.INGEST_SECRET + ":session"`.
  A default deploy has session key `"change-me:session"` → an attacker forges an `acs` cookie for any
  callsign incl. `ADMIN_CALLSIGNS` (sysop is decided purely by the cookie, `admin.ts:19-24`). Even with a
  strong secret, coupling the ingest machine credential to the user-session key means every ingest-box
  operator can forge any user's session. *Fix:* refuse boot when the secret is unset/`"change-me"`; make
  it a `wrangler secret`, not `[vars]`; derive the session key from a **separate** `SESSION_SECRET`. *Test:*
  boot with default → refuses; cookie signed with `"change-me:session"` → rejected.
- [x] **SR-SEC-02 (Critical) — unauthenticated device-key registration.** `keys.ts:19-24`:
  `const callsign = (session ?? parsed.data.callsign).toUpperCase();` — with no session, the body
  callsign is accepted, and `verified` is set from the *callsign's* badge, so an attacker's key is
  stored `verified:1` under a victim callsign and federated. `account.ts:authorize()` then accepts any
  signature from a registered key → `/api/account/<victim>/delete` (GDPR erasure + tombstones),
  `/bundle`, `/move`, and signed browser-ingest attributed to the victim. *Fix:* require a session
  bound to the callsign (or the ingest secret); reject `parsed.data.callsign` from anonymous requests.
  *Test:* `POST /keys/register` no cookie, `callsign:"OE8APR"` → 401.
- [x] **SR-SEC-03 (High) — reflected XSS in `/embed`.** `embed.ts:24` builds `cfg` and `:36` emits it
  raw as `<script>const CFG = ${cfg};`. `bbox` is used unescaped and `JSON.stringify` does not escape
  `<`/`/`, so `?bbox=</script><script>…</script>` breaks out (uppercased `cache` too — HTML tags are
  case-insensitive). No CSP; `x-frame-options: ALLOWALL`. Runs same-origin as the `acs` cookie. *Fix:*
  escape `<`/`>`/`&`/U+2028/2029 in the serialized JSON, validate `bbox` as four numbers, add a CSP.
- [x] **SR-SEC-04 (High) — box remote-control IDOR.** `box.ts:32-49` authorizes `handleBoxEnqueue`
  with "a session exists OR box secret" and no check that the session owns `boxId`; the TX callsign is
  `body.callsign`. Any signed-in user who guesses a `boxId` can queue `beacon/message/igate/digi/tx` to
  another operator's box → remote keying of someone else's radio. *Fix:* bind boxes to an owning
  account; require `session ∈ owners(boxId)`; derive the TX callsign from the session. **Touches ingest/TX
  — confirm before implementing.**
- [x] **SR-SEC-05 (High) — forgeable account-migration bundle.** `account.ts:132-167` validates only
  that the assertion key is *in* the attacker-supplied bundle; `callsign`, `verified`, and `keys[]` are
  unsigned by any source instance. On an instance where the callsign is new, an attacker imports
  `{callsign:"W1AW", verified:true, keys:[theirKey]}` → a verified account they don't hold, device key
  registered. *Fix:* require the bundle signed by the source instance's federation key; never trust a
  client `verified` flag. **Touches federation — confirm.**
- [x] **SR-SEC-06 (High) — magic-link token returned in-band.** `email.ts:48` returns
  `{ devToken, devLink }` whenever `sendEmail` returns false, which happens simply because
  `EMAIL_API_KEY`/`EMAIL_FROM` are unset — no explicit dev guard. A production instance without email
  configured hands the login token to the caller → account takeover. *Fix:* gate `devToken` behind an
  explicit `ALLOW_DEV_TOKENS` (default off); otherwise fail closed.
- [x] **SR-SEC-07 (High) — brute-forceable APRS verification code.** `callsign.ts:23-27`
  (`confirmAprsChallenge`) requires no session and has no attempt limit; the code is a 6-digit
  `Math.random()` (`:9`). ~10⁶ unthrottled tries mark any callsign control-verified, defeating the H5
  TX gate. *Fix:* bind confirm to the session that started the challenge; rate-limit + lock after N
  failures; `crypto.getRandomValues`; expire challenges.
- [x] **SR-SEC-08 (Medium) — non-timing-safe secret compares.** `===` on `x-ingest-secret`
  (`ingest.ts:38`), admin (`admin.ts:27`), box (`box.ts:24`), caches (`caches.ts:75`), forward, support,
  import — plus session/FED/challenge compares. *Fix:* constant-time compare (hash both sides).
- [x] **SR-SEC-09 (Medium) — rate limiting is per-isolate + spoofable IP.** `corroborate_privacy.ts:66-77`
  is a module-level `Map`; on CF it resets per isolate, and on Node/Bun `clientIp` trusts a
  client-settable `x-forwarded-for`. The ADR-4a per-IP limit, key-issuance throttle, and signed-ingest
  limit are all bypassable. *Fix:* durable counter (DO/D1/KV TTL); on non-CF derive IP from the socket.
- [x] **SR-SEC-10 (Medium) — no ingest batch/body cap.** `packages/shared/src/packet.ts:24` is
  `z.array(Packet)` unbounded; `ingest.ts:31` does `req.json()` with no size limit → one POST with
  millions of packets exhausts memory + one huge `DB.batch`. *Fix:* `.max(1000)`; Content-Length cap;
  chunk the batch.
- [x] **SR-SEC-11 (Medium) — sessions never expire server-side.** ✓verified: `auth.ts:262`
  returns `payload.split(".")[0]` after HMAC check and ignores the embedded `Date.now()` (`:252`); the
  30-day `Max-Age` is a client hint. A captured token is valid until the secret rotates. *Fix:* reject
  tokens older than a max age; add a revocable server-side session version.
- [x] **SR-SEC-12 (Medium) — account squatting.** `auth.ts:58-68` inserts the account row on
  `register/begin` before any passkey is proven, unauthenticated + unthrottled → pre-claim `W1AW` and
  lock out the real holder. *Fix:* persist only on `register/finish`; rate-limit; reap unfinished.
- [x] **SR-SEC-13 (Medium) — WebAuthn origin/rpId fall back to the `Origin` header.** `auth.ts:15-23`:
  `authOrigins = env.APP_URL ?? req.headers.get("Origin")` (rpId likewise). With env unset the
  origin/rpId binding validates against a client-supplied value. *Fix:* require `APP_URL`/`RP_ID`
  configured; never source the expected origin from headers.
- [x] **SR-SEC-14 (Low) — unauth `startAprsChallenge`** (`callsign.ts:6-21`) → outbound APRS spam +
  code farming. *Fix:* require a session bound to the callsign; rate-limit.
- [x] **SR-SEC-15 (Low) — reflective CORS with credentials** (`app.ts:379-390`). Mitigated by
  `SameSite=Lax` today but fragile. *Fix:* allowlist origins.

## Detail — Federation (`federation*.ts`, `tombstones.ts`, `corroborate.ts`, `relay.ts`)

Federation is **not safe against a malicious peer**. F4 (peer trust tiers + quarantine + corroboration
quorum) is explicitly launch-gating in `` and is the right home for most of these.

- [x] **SR-FED-01 (Critical) — signer/id outside the signature.** ✓verified: `federation.ts:269`
  signs `{type,id,data}` only; `signer` is unsigned metadata. `federation_sync.ts:204-234` applies a
  record without checking that `rec.id` is namespaced to the serving peer or that `rec.signer` equals
  its verified identity, then `upsertRemoteCache` does `INSERT OR REPLACE ... keyed by rec.id`. Any
  synced peer serves `id:"victim.net:cache:1", signer:"victim.net"` signed with its own key, overwrites
  the genuine mirror, and inherits the victim's `trusted` origin on the map. *Fix:* require
  `rec.id.startsWith(wk.instance + ":")` and `(rec.signer ?? feed.instance) === wk.instance`; pass
  `wk.instance` (never `rec.signer`) as `origin`. **Touches federation semantics — confirm.**
- [x] **SR-FED-02 (Critical) — tombstones purge arbitrary targets.** `federation_sync.ts:241-251`
  deletes `remote_caches`/`remote_finds WHERE global_id = d.targetId` with no check that `targetId`
  belongs to the emitting peer's namespace; tombstones are synced from every enabled peer incl.
  `unvetted`. A hostile peer censors any instance's records network-wide (180-day suppression) and
  forges ADR-5 GDPR deletes. *Fix:* require `d.targetId.startsWith(origin + ":")` with the verified
  `wk.instance`. **Touches federation semantics — confirm.**
- [x] **SR-FED-03 (High) — `/federation/submit` impersonation + self-mint trusted.**
  `federation_sync.ts:387-400` imports a submitter-supplied key, inserts `fed_peers ... trust='trusted'`,
  and checks only `rec.signer === b.instance` (self-consistent attacker strings); `FED_SUBMIT_INSTANCES`
  empty allows any name. *Fix:* bind `b.instance → publicKey` against the signed registry; default deny;
  never auto-`trusted` (use `unvetted`).
- [x] **SR-FED-04 (High) — peer key blindly re-pinned; rotation never verified.**
  `federation_sync.ts:117-118` updates `public_key` to whatever the peer's `/.well-known` serves now;
  `verifyRotationRecord` is exported + tested but never called, and `signed:false` yields
  "nothing to verify". A hijacked domain swaps identity keys with no continuity check. *Fix:* pin on
  first sight; on change require a valid `RotationRecord` chain; refuse `signed:false` regression.
- [x] **SR-FED-05 (High) — account-move records unauthenticated.** `federation_sync.ts:255-265`:
  any peer asserts any callsign moved to any instance (no `origin === d.toInstance`), and `d.ts` is
  unbounded → `ts = 2^40` freezes the pointer forever. *Fix:* require `origin === d.toInstance`; clamp
  `d.ts <= now + skew`.
- [x] **SR-FED-06 (High) — sync fetches have no timeout.** `federation_sync.ts:35-39,200` use `fetch`
  with no `AbortSignal.timeout` (gossip/corroborate use 3–5 s); `syncAllPeers` is sequential and runs
  before `pushToHub`/`relayPoll`/`runDigests`. One blackholed peer hangs the whole 5-min cron. *Fix:*
  `signal: AbortSignal.timeout(5000)` + per-peer budget.
- [x] **SR-FED-07 (Medium) — auto-promotion farmable; quorum defaults to 1.** `corroborate.ts:213`
  credits every peer that answered "yes" incl. `unvetted`; an always-yes peer never accrues `rep_failed`,
  crosses `shouldAutoPromote`, then `FED_CORROBORATION_QUORUM ?? 1` lets its lone "yes" mint Tier A.
  *Fix:* only credit peers whose evidence independently matched; require quorum ≥ 2 when an auto-promoted
  peer is in the winning set. **F4 territory — confirm.**
- [x] **SR-FED-08 (Medium) — mirror upserts lack version monotonicity.** `federation_sync.ts:278-301`
  `INSERT OR REPLACE` keyed only by `global_id`; a replayed older signed record rolls a mirror back
  (e.g. to pre-redaction content). *Fix:* `ON CONFLICT DO UPDATE ... WHERE excluded.updated_at >= remote_caches.updated_at`.
- [x] **SR-FED-09 (Medium) — browser-signed ingest ts + browser-rf TTL.** `ingest.ts:91-97` stores
  `p.ts` as-is (future/ancient); the TTL only prunes `source='firehose'`, so `browser-rf` rows are kept
  forever and future-dated rows sit permanently inside the verify window (`caches.ts:352` has no upper
  bound); signed batches are replayable for 5 min (no nonce). *Fix:* clamp `p.ts` to `[now-window, now+60]`;
  add `browser-rf` to the TTL; add `AND ts <= now` to the verify query.
- [x] **SR-FED-10 (Medium) — tombstone TTL resurrects deletes.** `app.ts:73-77` prunes
  `remote_tombstones` after 180 d; once gone, a cursor reset / new hub / submit-replay re-mirrors the
  erased PII. *Fix:* keep `remote_tombstones` indefinitely (PII-free) or never prune `find`/`account` kinds.
- [x] **SR-FED-11 (Medium) — `rlBuckets` unbounded** (`corroborate_privacy.ts:67-77`): expired windows
  overwritten, never deleted, no cap (unlike `negMemo`'s 5000). *Fix:* sweep when `size` exceeds a cap.
- [x] **SR-FED-12 (Low) — relay lease/answer not bound to spoke** (`relay.ts:88-106`): client-chosen
  `?instance=`, flat `FED_RELAY_SECRET`. *Fix:* per-spoke tokens.
- [x] **SR-FED-13 (Low) — signing-key load memoized as `null`** (`federation.ts:92-101`): one transient
  error caches `null` for the process lifetime → instance silently serves unsigned feeds. *Fix:* don't
  memoize rejections; log.

## Detail — Packet stack (`packages/packet`, `packages/ax25`)

Architecture is good (pure, clock-injected timers that can't pile up); the defects are in the abnormal
/ hostile-peer paths the loopback tests don't exercise.

- [x] **SR-PKT-01 (Critical) — FBB crash after `FQ`.** `fbb-session.ts:122-126` runs the recv-block
  code even when `phase === "done"`; `fbb-forward.ts:34-42` keeps feeding lines after `r.done`. A peer
  sending `FQ\r\x1a\r` makes `pendingRx.shift()` return `undefined` → `p.type` throws in the socket
  data callback (`fbb-scheduler.ts:105-109`), an uncaught exception that kills the daemon remotely.
  *Fix:* `if (this.phase !== "recv-block") return { out: [] };` before line 123; bail on empty
  `pendingRx`. *Test:* `feed("FQ")` then `feed("\x1a")` → no throw.
- [x] **SR-PKT-02 (High) — short FS reply loses mail.** `fbb-session.ts:68-76`: a missing verdict
  falls through to `store.sent(p.bid)`; `FS +` to a 5-proposal block dequeues 4 messages without
  sending. *Fix:* treat missing verdict as defer (`if (v !== "accept" && v !== "reject") return;`).
- [x] **SR-PKT-03 (High) — premature `markSent` on timeout.** `fbb-scheduler.ts:103,114-115`:
  `store.sent` runs while building body lines and `markSent` reconciles unconditionally, even on the
  120 s timeout / abnormal close → a link that dies mid-body drops the message forever. *Fix:* only
  `markSent` on clean FQ completion; mark nothing on timeout (BID dedup makes re-send safe).
- [x] **SR-PKT-04 (High) — SABME retries as SABM.** `ax25/link.ts:175-176` hard-codes `tx("SABM")` on
  T1 retry while `this.mod` stays 128 → modulus mismatch, garbled control fields, REJ/T1 churn to N2.
  *Fix:* `tx(this.mod === 128 ? "SABME" : "SABM", ...)` (mirror `reestablish()` :236).
- [x] **SR-PKT-05 (High) — SessionServer mis-decodes SABME.** `session-server.ts:42-45` decodes with
  default `extended=false` while the link adopts mod-128 on inbound SABME (`link.ts:92`) and replies UA
  → REJ-storm livelock. *Fix:* refuse SABME (reply DM) or track per-session `extended` and pass it.
- [x] **SR-PKT-06 (High) — NET/ROM circuits have no timers.** `netrom-circuit.ts:10-11,48-54,135-142`:
  a lost ConnReq/ConnAck/DiscAck/Info leaves the circuit stuck forever and leaks the object + growing
  `txq`. *Fix:* deadline-based T1 (clock-injected) retransmit/teardown; cap `txq`.
- [x] **SR-PKT-07 (High) — forwarder connect has no timeout.** `fbb-scheduler.ts:97-98`: `await
  link.connect()` before the session timer starts; `busy.add` is only cleared in `finally`, which never
  runs if connect never settles → partner blocked forever. *Fix:* race `connect()` against a timeout.
- [x] **SR-PKT-08 (Medium) — warming slot never expires** (`session-server.ts:66-93`): a never-settling
  factory leaves a `warming` slot forever, swallowing SABMs and consuming `maxSessions`. *Fix:* warm-up
  deadline checked in `poll()`.
- [x] **SR-PKT-09 (Medium) — unbounded channels + scrollback** (`session.ts:99-112`): inbound SABM
  auto-opens a channel (removed only by UI `close()`); `ch.lines` uncapped. *Fix:* cap lines + channels;
  auto-remove disconnected.
- [x] **SR-PKT-10 (Medium) — NODES table unbounded + poisonable** (`netrom-node.ts:33,52-58`):
  `maxRoutes` optional with no default; `learn` replaces on `quality >= cur` → forged 255 hijacks
  `best()`. *Fix:* default `maxRoutes` (~500) + rate-limit learns.
- [x] **SR-PKT-11 (Medium) — hostile-peer OOM** (`link-app.ts:60-62`, `bbs.ts:141`, `fbb-session.ts:131`,
  `netrom-connect-through.ts:74`): `buf += dec(info)` uncapped; body pushes uncapped; FBB ignores its
  proposed `size`. *Fix:* cap `buf` (8 KiB → disconnect), cap body bytes, abort over-size recv-blocks.
- [x] **SR-PKT-12 (Medium) — ConnReq in any state + window=0** (`netrom-circuit.ts:87-101`): forged
  ConnReq mid-transfer rewrites peer ids; `window = Math.min(info[0] ?? window, window)` → 0 wedges
  `pump()`. *Fix:* state/id check on ConnReq; clamp window ≥ 1.
- [x] **SR-PKT-13 (Medium) — CachedBbsStore silent discard** (`cached-bbs-store.ts:56`): tells the RF
  user "stored" then `.catch(() => {})` on backend failure; also `postedAt: Math.floor(id)` is negative.
  *Fix:* retry queue or mark the cached message failed.
- [x] **SR-PKT-14 (Medium) — `hasBid()` stubbed false** (`fbb-scheduler.ts:47`): always answers `+`,
  so partners retransmit full bodies every session and A→B→A loops persist. *Fix:* carry a BID set from
  the pool; answer `-` for known BIDs.
- [x] **SR-PKT-15 (Low) — silent link reset on peer SABM** (`ax25/link.ts:111-117`): `reset()` discards
  unacked data and `to("connected")` is a no-op when already connected → host never told. *Fix:* emit
  `ev.error?.("link reset by peer")`.

## Detail — Ingest daemon (`apps/ingest`)

- [x] **SR-ING-01 (Critical) — reconnect storm.** ✓verified: `aprsis.ts:34-36` registers `retry` on
  both `error` and `close`; a socket failure emits both → one failure spawns two reconnects (2ⁿ), no
  dup-connection guard, old sockets keep emitting duplicate packets. Same in `igate.ts:67-68`,
  `uplink.ts:23-24`. *Fix:* reconnect only on `close`; generation counter; `destroy()` +
  `removeAllListeners()` before a new socket. *Test:* fake server that drops on accept → exactly one
  outstanding attempt after 3 cycles. **Touches ingest behavior — confirm.**
- [x] **SR-ING-02 (High) — no stale-connection detection** (`aprsis.ts:17-33`): no `setTimeout`/
  `setKeepAlive`; a half-dead server keeps TCP up and no event fires. *Fix:* `s.setTimeout(90_000,
  destroy)` reset on data (the `#` keepalives make 90 s safe).
- [x] **SR-ING-03 (High) — gateway outage drops every batch** (`index.ts:196`): on fetch failure the
  batch is discarded (no retry/spool). *Fix:* prepend back onto a bounded buffer (~5000, drop-oldest).
- [x] **SR-ING-04 (High) — HTTP errors treated as success** (`index.ts:191-195`): `res.ok`/`status`
  never checked; a 401/413/500 loses the batch with no log line. *Fix:* `if (!r.ok) throw` → engages
  the retry buffer.
- [x] **SR-ING-05 (High) — forwarder leaks KISS socket + timer** (`forwarder.ts:122`): connect timeout
  rejects without `sock.destroy()` or `clearInterval(poll)`; Direwolf's few KISS slots fill, locking
  out the main ingest. *Fix:* `clearInterval(poll); sock?.destroy()` in the timeout + `onFail` paths.
- [x] **SR-ING-06 (Medium) — no backoff/jitter** (all transports, fixed 3 s). *Fix:* shared
  `min(cap, base·2ⁿ)·(0.5+rand)` helper, reset after >60 s stable.
- [x] **SR-ING-07 (Medium) — outbox acked on a possibly-dead socket** (`uplink.ts:32-37`): `ready`
  stays true until error/close; `write()` return + drain ignored → announces/weather acked and
  destroyed without reaching APRS-IS. *Fix:* report success only when the socket is verifiably alive.
- [x] **SR-ING-08 (Medium) — KISS RX buffer unbounded + survives reconnect** (`kiss.ts:44-49`): points
  at a non-KISS port → `this.buf` grows forever; stale partial frame prepended next connect. *Fix:*
  `buf=[]` at connect + ~64 KiB cap.
- [x] **SR-ING-09 (Low) — "heard" maps never evicted** (`igate.ts:25`, `netromnode.ts:28,103`). *Fix:*
  periodic sweep like `digipeater.ts`.
- [x] **SR-ING-10 (Low) — outbox poll failures swallowed** (`index.ts:247` `} catch {}`). *Fix:*
  rate-limited error log + recovery line.
- [x] **SR-ING-11 (Low) — UDP/CoT listeners die on bind error** (`cotlisten.ts:34-35`, `axudp.ts`).
  *Fix:* exit(1)/retry; move the "listening" log into the bind callback.
- [x] **SR-ING-12 (Low) — serial PTT no `error` listener** (`ptt.ts:25`; module unwired today). *Fix:*
  `port.on("error"/"close")`.

## Detail — Tri-runtime plumbing (`servers/{node,bun}`, `workers/gateway` DO/index/room)

- [x] **SR-RT-01 (High) — `scheduled()` ignores the cron.** ✓verified: `index.ts:26` runs
  `runScheduled` for both crons (`wrangler.toml:32`: `"0 4 * * *"` + `"*/15 * * * *"`), so the full
  nightly TTL/rollup/digest job runs 96×/day on Workers — a D1 rows_read cost bug and a digest-cadence
  divergence from Node/Bun. *Fix:* `event.cron === "0 4 * * *" ? runScheduled(env) : syncAllPeers(env)`.
- [x] **SR-RT-02 (High) — Node/Bun TTL never runs on frequent restart** (`server.ts:139`): plain
  `setInterval(24 h)` with no initial run; a Pi rebooting more often than daily never prunes. *Fix:*
  run once at startup then re-arm.
- [x] **SR-RT-03 (High) — servers drop most of `Env`** (`server.ts:44-100`): Bun omits `ADMIN_CALLSIGNS`
  (no sysop possible); both omit `APP_URL`, `RP_ID`, `EMAIL_*`, `VAPID_*`, `PACKETS_TTL_HOURS`,
  `API_RATE_*`, `FIRST_PARTY_SITES`, etc. → features silently dead on self-host. *Fix:* build env from
  `process.env` filtered by an exported `ENV_KEYS`.
- [x] **SR-RT-04 (High) — DO `webSocketMessage` crashes on junk** (`room.ts:39-43`): unguarded
  `JSON.parse`; also invoked with `ArrayBuffer` (the `msg:string` type is a lie). Node wraps this in
  try/catch. *Fix:* try/catch + decode binary.
- [x] **SR-RT-05 (High) — growing tables with no TTL** (`app.ts:66-78`): prunes only firehose
  positions, `packets_recent`, tombstones, relay queue. Unbounded: `messages` (also unindexed →
  `workbench.ts:78` full scans), `sensor_readings`, `port_stats`, `watch_alerts` (never deleted),
  `rendezvous_log`, `node_mheard`. *Fix:* extend `runScheduled` with bounded retention + `idx_messages_ts`.
- [x] **SR-RT-06 (High) — Node rooms no heartbeat/backpressure** (`rooms.ts:25-39`): no ping/isAlive
  sweep; `dispatch` ignores `bufferedAmount`. A half-open client (phone out of coverage) buffers the
  whole region firehose → slow OOM + leaked Set entry. *Fix:* 30 s heartbeat + `bufferedAmount` cap.
- [x] **SR-RT-07 (Medium) — TTL delete unindexed** (`app.ts:68`, schema `0001:91`): `DELETE ... WHERE
  source='firehose' AND ts<?` scans the whole table; on synchronous better-sqlite3 this stalls the event
  loop. *Fix:* migration `idx_pos_source_ts (source, ts)` + batched delete.
- [x] **SR-RT-08 (Medium) — shims accept `undefined` binds** (`d1.ts:14-17`): coerce `undefined→null`
  while real D1 throws `D1_TYPE_ERROR` → green on Node/Bun, 500 on Workers. *Fix:* throw from `norm()`.
- [x] **SR-RT-09 (Medium) — shim `meta` zeroed for readers** (`d1.ts:29-31`): `last_row_id:0,changes:0`
  for row-returning statements; latent `RETURNING` parity break. *Fix:* populate from
  `last_insert_rowid()`/`changes()`.
- [x] **SR-RT-10 (Medium) — Node body has no size cap** (`server.ts:147-154`): buffers the whole body
  before routing/auth → multi-GB POST OOMs the Pi. *Fix:* track total, `destroy()` + 413 past ~20 MB.
- [x] **SR-RT-11 (Medium) — no process failure/shutdown handlers** (`server.ts`): no
  `unhandledRejection`/`uncaughtException`/SIGTERM; one stray rejection kills the gateway. *Fix:* add
  log-don't-die + graceful close/checkpoint.
- [x] **SR-RT-12 (Low) — stage media orphaned; FS store blacklist sanitizer** (`stages.ts:38`,
  `media.ts:9`): `DELETE cache_stages` never calls `MEDIA.delete`; the `..`-strip guard is unsafe for
  any future raw-key caller. *Fix:* delete media on stage replace; allowlist regex + `path.resolve`
  containment.
- [x] **SR-RT-13 (Low) — DO close/error handlers** (`room.ts:45`): `close()` with no code/reason; no
  `webSocketError`. *Fix:* echo `close(code, reason)` + add `webSocketError`.
- [x] **SR-RT-14 (Low) — Bun backpressure drop + double-scheduled sync** (`rooms.ts:38`, `server.ts:139`
  vs `app.ts:79`): Bun `send()` backpressure return ignored → dropped geofence prompts; `syncAllPeers`
  runs on the interval and inside `runScheduled`. *Fix:* check `send()`; dedupe sync.

## Detail — APRS parsers (`packages/aprs`)

Text decoders are hardened (length guards, null-returning); exposure is in the binary/DSP surfaces.

- [x] **SR-PARSE-01 (Critical) — Meshtastic `fixed32` OOB.** `meshtastic.ts:62`: `i32le` reads a
  4-byte `DataView` with no bounds check; a truncated fixed32 throws `RangeError` (tears down the
  browser mesh link via the read loop's catch), or — when the frame is a subarray — silently reads
  into the adjacent frame and plants a bogus station. *Fix:* `p+4 > b.length ? 0 : …` and `break` in
  `walk`. *Test:* `parseMeshPacket([0x0d,0x01,0x02])` → null, no throw.
- [x] **SR-PARSE-02 (High) — AFSK HDLC unbounded accumulator** (`afsk.ts:63-67`): a steady `0101` tone
  hits neither the >6-ones reset nor a flag → `this.bits` grows ~1200/s forever on a soundcard IGate.
  *Fix:* drop when `bits.length > 4096`.
- [x] **SR-PARSE-03 (Medium) — object/item null-island** (`decode.ts:106-124`): `posFields` returns
  `{lat:0,lon:0}` for non-position, spread unconditionally → `;SHORT` becomes a station at 0,0.
  *Fix:* omit coords unless `decodePosition` returned a position (mesh/cot already reject 0,0).
- [x] **SR-PARSE-04 (Medium) — encoder emits `60.00` minutes** (`encode.ts:14-16`, `position.ts:26-27`):
  rounding at 2 dp yields `0460.00N`; strict APRS-IS/CWOP/NOAA reject it. *Fix:* round total
  hundredth-minutes and carry into degrees.
- [x] **SR-PARSE-05 (Medium) — CoT recompiles RegExp per attribute** (`cotin.ts:12-14`, ~7×/event):
  GC churn on the hot path (no ReDoS). *Fix:* hoist precompiled module-level regexes.
- [x] **SR-PARSE-06 (Low) — MGRS band wrong 80–84°** (`mgrs.ts:14-17`): `BANDS[20]` undefined → `"Z"`.
  Display-only. *Fix:* `if (lat >= 72) return "X";`.

## Detail — Web app (`apps/web`) — PENDING (final agent)

_(SR-WEB-* — WebSocket reconnect/leak behavior, MapLibre source/marker leaks, offline-cache growth,
device-key handling, no-emoji guard coverage. To be inserted.)_

## Detail — Configuration & observability — PENDING (final agent)

_(SR-CFG-* — full env-drift table across ingest/servers/gateway vs the `.env.example` files, startup
validation, /healthz coverage per runtime, deploy/ scripts + log rotation on a Pi. To be inserted.)_

---

## Runtime-scenario walkthroughs

1. **High packet load (busy channel + tunnelled AXUDP).** `messages`/`sensor_readings`/`positions`
   grow without TTL (SR-RT-05); the unindexed `messages` scan (`workbench.ts:78`) and the unindexed
   firehose delete (SR-RT-07) slow together; on Node the synchronous TTL delete freezes HTTP/WS for
   seconds once `positions` is large; the Node rooms buffer per-slow-client (SR-RT-06). Hostile framing
   can OOM the packet stack (SR-PKT-11) or crash it (SR-PKT-01).
2. **APRS-IS server flapping overnight.** The double-retry (SR-ING-01) turns one bad night into an
   exponential login storm under one callsign → APRS-IS throttle/ban + fd exhaustion; a half-dead
   server that stops sending is never noticed (SR-ING-02); the fixed 3 s no-jitter reconnect
   (SR-ING-06) spams the SD-card log and hits `rotate.aprs2.net` in sync across boxes.
3. **Gateway/D1 unavailable for hours.** Every ingest batch is dropped with no retry (SR-ING-03) and,
   if the failure is an HTTP status, with no log line at all (SR-ING-04) — hours of RF (incl. the
   logger positions Tier A needs) vanish invisibly. Outbox announces are acked-and-destroyed on the
   dead uplink (SR-ING-07).
4. **Malicious federation peer.** Impersonates a trusted instance and overwrites its mirrored caches
   (SR-FED-01), censors arbitrary records via forged tombstones (SR-FED-02), self-mints a `trusted`
   peer row (SR-FED-03), hijacks account-move pointers (SR-FED-05), or simply blackholes one sync fetch
   to hang the whole cron (SR-FED-06). An always-yes unvetted peer farms its way to Tier-A minting
   (SR-FED-07).
5. **Weeks of uptime on a Pi nobody reboots.** Unbounded growth (SR-RT-05, SR-ING-08/09, SR-PKT-09/10,
   SR-FED-11) + leaked sockets/circuits/slots (SR-ING-05, SR-PKT-06/07/08) accumulate; a single
   unhandled rejection kills the gateway with no supervisor (SR-RT-11); if the box reboots more often
   than daily the TTL never runs (SR-RT-02), so the DB only grows.

## Missing tests that would catch the Critical/High set

- **Trust:** `verify.test.ts` cases for self-IGate (SR-TRUST-01), teleport speed (SR-TRUST-02), stale
  `appGeo.ts` (SR-TRUST-03); a `caches.ts` integration test asserting `loggerOwnIgates` is populated.
- **Security:** `keys.test.ts` anonymous-register → 401 (SR-SEC-02); `embed.test.ts` XSS payload inert
  (SR-SEC-03); a boot-guard test refusing `change-me` (SR-SEC-01); a brute-force lockout test (SR-SEC-07).
- **Federation:** namespace-mismatch record rejected (SR-FED-01), cross-namespace tombstone ignored
  (SR-FED-02), submit-impersonation 403 (SR-FED-03), key-rotation-without-proof rejected (SR-FED-04),
  hung-peer sync budget (SR-FED-06).
- **Packet:** post-`FQ` line no-throw (SR-PKT-01), `FS +` partial-verdict mail retained (SR-PKT-02),
  timeout → `markSent([])` (SR-PKT-03), mod-128 SABME retry (SR-PKT-04), lost-ConnReq circuit teardown
  (SR-PKT-06).
- **Ingest:** single-connection-after-3-failures (SR-ING-01), idle-timeout reconnect (SR-ING-02),
  bounded retry buffer replay (SR-ING-03), `!res.ok` re-queue (SR-ING-04), forwarder socket/timer
  cleanup (SR-ING-05).
- **Runtime:** conformance test reflecting `Env` keys (SR-RT-03), `scheduled({cron})` branch (SR-RT-01),
  boot-time TTL run (SR-RT-02), DO junk-frame no-throw (SR-RT-04), TTL-covers-all-growing-tables
  (SR-RT-05), shim `undefined`-bind + `RETURNING` meta parity (SR-RT-08/09).
- **Parsers:** Meshtastic truncated-fixed32 (SR-PARSE-01), AFSK bounded accumulator (SR-PARSE-02),
  object/item non-null-island (SR-PARSE-03), encoder minutes<60 (SR-PARSE-04).
