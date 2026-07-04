<!-- SPDX-License-Identifier: CC-BY-SA-4.0 -->
# HAPPY-CODING.md — the post-1.0 engineering backlog

> The persistent, prioritised worklist for aprscaching after the 1.0.0 tag. It folds together every
> open finding from `STABILITY-REVIEW.md` (the Criticals, Highs AND the P1 Mediums are **done**;
> the open set is the P2/P3 Mediums and Lows)
> and the intentionally-deferred capability work from `TODO.md`, each item carrying **priority**,
> **rationale**, **impact**, and **effort** so a contributor can pull the next-most-valuable thing off
> the top without re-deriving the audit.
>
> - `STABILITY-REVIEW.md` — the record of *what was found* (with stable `SR-*` IDs and line refs).
> - **This file** — the record of *what is left to do*, ranked, and why.
> - `TODO.md` — the short "intentionally deferred until after 1.0" list; its items are folded in below
>   under **Deferred capabilities** with a one-line pointer, not duplicated.
>
> **Legend.** Priority: **P1** (do before opening the federation network / heavy public traffic) ·
> **P2** (do in an early 1.0.x) · **P3** (nice-to-have / opportunistic). Effort: **S** (<½ day) ·
> **M** (½–2 days) · **L** (multi-day / needs a migration or a design note). Every fix MUST keep the
> launch invariants (trust tiers A/B/C, transport ≠ trust, ingest locality, ADR-3 source link,
> tri-runtime parity) and land with a test + green `pnpm -r test` / smoke.

---

## P1 — before opening the network / facing sustained public traffic — ✅ DONE (2026-07-03)

**The entire P1 batch is implemented and tested** (commits c7275c9 · 7e7e4d6 · f335da8 · 1c7a59a ·
647f549 · 7c79b9a — see STABILITY-REVIEW.md Update 2). SR-TRUST-04 (find-log idempotency, listed
under P2 Trust hygiene) is the one launch-adjacent item deliberately left with the P2s: it needs a
data-dedup decision on existing rows before its unique index can land. The table below is kept as
the record of what the batch covered.

| ID | Area | Item | Rationale / impact | Effort |
|----|------|------|--------------------|--------|
| SR-SEC-09 | security | Durable, un-spoofable rate limiting | Limits are per-isolate `Map`s keyed on client-settable `x-forwarded-for`; the ADR-4a per-IP read limit, key-issuance throttle and signed-ingest limit are all bypassable. Move to a DO/D1/KV TTL counter; derive IP from the socket off-CF. | M |
| SR-SEC-10 | security | Cap ingest batch + body size | `z.array(Packet)` is unbounded and `req.json()` has no size limit — one POST of millions of packets exhausts memory and a single huge `DB.batch`. Add `.max(1000)`, a Content-Length cap, and chunk. | S |
| SR-SEC-08 | security | Timing-safe secret comparisons | `===` on `x-ingest-secret`, admin, box, caches, forward, support, import and session/FED/challenge compares leaks via timing. Constant-time compare (hash both sides). | S |
| SR-SEC-11 | security | Server-side session expiry + revocation | The signed `Date.now()` is ignored; a captured cookie is valid until the secret rotates. Reject tokens past a max age; add a revocable session version. | M |
| SR-SEC-12 | security | Persist accounts only on `register/finish` | `register/begin` inserts the account row unauthenticated + unthrottled → callsign squatting/lock-out. Persist on finish; rate-limit; reap unfinished. | M |
| SR-SEC-13 | security | Require `APP_URL`/`RP_ID`; never trust `Origin` | WebAuthn origin/rpId fall back to the client `Origin` header when env is unset → binding validates an attacker value. Fail closed if unconfigured. | S |
| SR-FED-07 | federation | Corroboration quorum ≥ 2 + credit only matching peers | Auto-promotion is farmable and `FED_CORROBORATION_QUORUM ?? 1` lets one always-yes `unvetted` peer mint Tier A. This is **F4 launch-gating** territory — only credit peers whose evidence independently matched; require quorum ≥ 2 when an auto-promoted peer is in the winning set. | L |
| SR-FED-08 | federation | Version-monotonic mirror upserts | `INSERT OR REPLACE` keyed only by `global_id` lets a replayed *older* signed record roll a mirror back (e.g. to pre-redaction content). Add `WHERE excluded.updated_at >= …`. | S |
| SR-FED-09 | federation | Clamp ingest `ts`; TTL `browser-rf`; bound verify window | Unvalidated `p.ts` (future/ancient) sits inside the verify window forever and `browser-rf` rows never prune. Clamp `p.ts` to `[now-window, now+60]`, add `browser-rf` to the TTL, add `AND ts <= now` to the verify query. Adjacent to the trust model — keep transport ≠ trust intact. | M |
| SR-FED-10 | federation | Don't let tombstone TTL resurrect GDPR deletes | Pruning `remote_tombstones` after 180 d lets a cursor reset / new hub / submit-replay re-mirror erased PII (ADR-5 breach). Keep tombstones indefinitely (they're PII-free) or never prune `find`/`account` kinds. | S |
| SR-RT-11 | runtime | Process failure + graceful shutdown handlers (Node/Bun) | No `unhandledRejection`/`uncaughtException`/SIGTERM — one stray rejection kills the gateway with no supervisor, and SIGTERM doesn't checkpoint. Log-don't-die + graceful close. High leverage for the unattended-Pi story. | S |
| SR-RT-10 | runtime | Node request body size cap | The Node bridge buffers the whole body before auth → a multi-GB POST OOMs the Pi. Track total; `destroy()` + 413 past ~20 MB. | S |
| SR-RT-07 | runtime | Index + batch the firehose TTL delete | `DELETE … WHERE source='firehose' AND ts<?` full-scans; on synchronous better-sqlite3 it stalls the event loop once `positions` is large. Add `idx_pos_source_ts` (migration) + batched delete. | M |

## P2 — early 1.0.x hardening — ✅ DONE (2026-07-03)

**The entire P2 batch is implemented and tested** across four sub-batches: **P2a** packet-stack
robustness (SR-PKT-08/09/10/11/13/14), **P2b** ingest resilience (SR-ING-06..12), **P2c** tri-runtime
parity + growth (SR-RT-08/09/12/14), **P2d** federation edges + parsers + find idempotency
(SR-FED-12/13, SR-PARSE-03..06, SR-TRUST-04 · migration `0008`). Full suite green (packet 114, aprs
106, gateway 207, node 24, ingest 18, …) plus the Node/SQLite conformance smoke + geofence + the
two-instance federation e2e. The prose below is kept as the record of what the batch covered.

Open Mediums that degrade gracefully today but should be closed before the instance runs for months
unattended or under a hostile packet peer.

**Packet stack (hostile-peer robustness).** SR-PKT-08 warming-slot deadline · SR-PKT-09 cap channels +
scrollback · SR-PKT-10 default `maxRoutes` + rate-limit NODES learns (forged-255 poisoning) ·
SR-PKT-11 cap RX line buffers / BBS+FBB bodies (OOM) · SR-PKT-13 CachedBbsStore retry-or-fail (no
silent discard) · SR-PKT-14 real `hasBid()` from the pool (stop full-body retransmit loops). *Rationale:*
these are the abnormal/hostile paths the loopback tests don't exercise; each is a slow-OOM or
wasted-airtime bug over weeks. *Effort:* S–M each.

**Ingest resilience.** SR-ING-06 exponential backoff + jitter (stop synchronized `rotate.aprs2.net`
hammering + SD-card log spam) · SR-ING-07 ack outbox only when the socket is verifiably alive ·
SR-ING-08 bound + reset the KISS RX buffer on a non-KISS stream · SR-ING-09 evict stale "heard" maps ·
SR-ING-10 log outbox-poll failures · SR-ING-11 UDP/CoT listeners retry on bind error · SR-ING-12 serial
PTT `error`/`close` listener (unplug shouldn't crash). *Effort:* S each.

**Runtime parity + growth.** SR-RT-08 shim must throw on `undefined` binds (D1 parity) · SR-RT-09
populate shim `meta` for row-returning statements (`RETURNING` parity) · SR-RT-12 delete stage media on
replace + allowlist the FS media-store path · SR-RT-14 Bun backpressure check + dedupe double-scheduled
sync. *Rationale:* the parity ones are latent "green on Node, 500 on Workers" traps; catch them in
conformance. *Effort:* S each.

**Federation edges.** SR-FED-11 sweep the `rlBuckets` map (unbounded in long-lived runtimes) · SR-FED-12
per-spoke relay tokens · SR-FED-13 don't memoize a failed signing-key load as `null` forever (silently
serving unsigned feeds). *Effort:* S each.

**Parser correctness.** SR-PARSE-03 omit coords for non-position object/item (no 0,0 null-island) ·
SR-PARSE-04 encoder must not emit `60.00` minutes (strict APRS-IS/CWOP/NOAA reject) · SR-PARSE-05 hoist
CoT regexes off the hot path · SR-PARSE-06 MGRS band letter for 80–84° (display-only). *Effort:* S each.

**Trust hygiene.** SR-TRUST-04 find-log idempotency — a partial unique index on
`cache_logs(cache_id, logger_call) WHERE log_type='found'` so racing/replayed POSTs don't double-count a
verified find. Small migration; keeps the tier semantics untouched. *Effort:* S.

## P3 — opportunistic / low-severity — ✅ DONE (2026-07-03)

Both open Lows are now closed: **SR-SEC-15** CORS credentials are allowlisted to APP_URL/CORS_ORIGINS
(an unlisted origin still reaches the public Bearer-keyed read API but can't ride a session cookie);
**SR-PKT-15** a peer SABM on an already-connected AX.25 link emits `"link reset by peer"` so the host
learns its unacked data was discarded. Tested (`p3_cors.test.ts`, `link.test.ts`), full suite + smoke green.

## Two audit passes — ✅ BOTH DONE

Both subsystem deep-reads were completed and their findings fixed; the stability-review open set is now
empty (every SR-* finding ticked). Details live in STABILITY-REVIEW.md under each `Detail —` section.

- **`SR-WEB-*` — web app (`apps/web`). ✅ DONE (2026-07-04).** WS reconnect-with-backoff (was: live
  features died silently on any drop); `setStyle`/theme-switch overlay re-add via a `styleEpoch`;
  MapLibre setup-effect cleanup + `once('load')` deregistration; the device signing key moved to a
  non-extractable IndexedDB `CryptoKey` (was: extractable PKCS8 in localStorage) with a generation-race
  guard; the no-emoji guard widened to `public/` (sw.js) + `.js/.mjs`. Offline/storage + marker
  diffing were audited clean. See STABILITY-REVIEW.md `SR-WEB-*`.
- **`SR-CFG-*` — configuration & observability. ✅ DONE (2026-07-03).** Env drift closed (27 ingest
  vars documented in `.env.example`, zero drift), numeric env validated (`config.ts` numEnv/portEnv +
  a dotenv loader for the `pnpm dev` path), `/health` confirmed the single health path, and the
  compose files now cap Docker log growth on an unattended Pi. See STABILITY-REVIEW.md `SR-CFG-*`.

## Engineering-quality follow-ups (not from the security audit)

- **Type-aware ESLint.** The flat config is intentionally non-type-aware for speed/friction. Once the
  baseline is stable, consider a separate, slower `lint:types` job enabling `@typescript-eslint`
  type-checked rules on `workers/` + `packages/`. *Priority:* P3 · *Effort:* M.
- **Burn down the 40 lint warnings.** The green baseline carries 40 warnings (mostly unused vars /
  `no-explicit-any`-adjacent). Clear opportunistically; never let the count grow. *Priority:* P3 · *Effort:* S.
- **Deeper CI topologies.** Exercise more of `deploy/` (topologies 1–4) in CI beyond the current
  tri-runtime conformance — reserved seam, open when a topology regresses. *Priority:* P3 · *Effort:* L.

## Deferred capabilities (from `TODO.md` — pointer, not duplicate)

Intentionally post-1.0; most **cannot be validated headlessly** and need hardware or a live partner.
See `TODO.md` for the full text and doc refs.

- **Needs hardware / a live peer:** owned-RF Tier A + 44net PoP + IPIP-Mesh/BGP · FBB LZHUF (B0/B1)
  compression (byte-exact vs a real FBB) · live-radio behaviour of the pure codecs (TNC/rig/raw-IP/off-air).
- **Native packaging:** Capacitor mobile shell (build/sign/store pipeline).
- **Future ideas (wanted, not built):** retro read-only access (Finger/Gopher/Gemini) · ham-radio QSO
  logbook with ADIF + LoTW/eQSL/QRZ · CoT streaming (SSE/long-poll) feed · live-room region sharding by
  geohash · one-click POI overlay (OSM/Wikidata).
- **Deferred by design:** additional CI depth and the federation push-to-hub rendezvous-relay
  corroboration path — reserved seams, opened on concrete need.
