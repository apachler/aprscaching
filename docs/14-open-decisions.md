# Open Decisions (ADR set) — ACCEPTED

Status: **Accepted** — decided 2026-06-25 via Q&A with OE8APR. These resolve the cross-cutting
open points and unblock `docs/11` (features) and `docs/12` (sustainability). Implementation notes
are written against the current codebase (account surrogate `account_id` in `0010`, `account_callsigns`
in `0011`, `callsign_history` in `0010`, per-account Ed25519 device-key signing, control-verification-
gated credit).

---

## ADR-1 — Leaderboard credit · **ACCEPTED: rank callsigns, aggregate per person on profiles**
Leaderboards rank by **callsign**; a person's **own profile sums** all their verified held calls.
A find is credited **once** to the logging call (control-verification-gated, as today).

**Implementation.** Leaderboard query stays per-call. Add a profile aggregation that sums finds
over `account_callsigns` for the signed-in account. No double-counting; no schema change. (Optional
future toggle: "show as one operator" de-duped leaderboard.)

## ADR-2 — Callsign reassignment · **ACCEPTED: finds follow the account/person**
Authorship belongs to the **account**, not the call string. A reassigned call starts fresh for the
new holder; the prior holder keeps their finds, displayed under the call **as held at that time**.

**Implementation.** Attribute finds by `(account_id, callsign, timestamp)`; resolve display via
`callsign_history` time windows — **never join on the bare call string**. Verify every find-writing
path stamps `account_id` (from `0010`); add it if any path stores only the call. Per-account Ed25519
signing already makes authorship provable across reassignment.

## ADR-3 — AGPL §13 source link · **ACCEPTED: add now (launch-blocking)**
Every deployed instance shows a visible **"Source"** link pinned to the **running commit/tag**,
plus a machine-readable `/.well-known/source` (or `/source` redirect). Self-host docs instruct
operators to point it at *their* modified source.

**Implementation.** Footer/About component + build-time `VERSION`/commit injection + one
well-known route; applies to both Cloudflare and Node deployments; paragraph in the self-host
README. Begin per-file SPDX headers incrementally (not launch-blocking). **Do before first public
deploy.** No schema. (Spec + checklist below.)

## ADR-4a — Public read API · **ACCEPTED: free + per-IP limits + free higher-throughput keys**
Read-only API; anonymous access **rate-limited per IP**; **free** `api_keys` raise limits
(recognition model — keys are free, never paywalled). Cap bbox size, paginate, edge-cache
bbox/detail, CORS open for embeds.

**Implementation.** `api_keys` table (lands with `docs/11`). Edge rate-limit (per-IP + per-key),
response caching, read-only enforcement. Honors cost rules and ad-free/recognition-only stance.

## ADR-4b — Alerts/push · **ACCEPTED: permission + PWA-install gated, with email-digest fallback**
Push is permission- and PWA-install-gated (iOS needs an installed PWA); non-push users get **in-app
alerts + an email digest**. Push **never** blocks the in-field geofence prompt. Coalesce/throttle;
per-topic subscribe/unsubscribe.

**Implementation.** `push_subs` table (with `docs/11`) + email-digest job + PWA-install gating.
Topics: nearby / new-cache / DNF. iOS fallback is mandatory.

## ADR-5 — Federated deletes · **ACCEPTED: signed tombstones peers honor**
Account/find deletion emits a **signed tombstone** that peers fetch and honor, removing mirrored
copies — so GDPR deletes propagate across the open network.

**Implementation.** On `DELETE /api/account/:call/delete` (and find deletes), write a signed
tombstone; expose `GET /federation/tombstones` (Ed25519-signed, like other feeds); peers verify the
signature and purge matching mirrored records on sync. New `tombstones` table + a federation
migration. Tombstones carry no PII (just signed IDs + timestamp). Retain tombstones long enough for
peers to converge. (Spec below.)

---

## Implementation roadmap (post-decision)

| Item | Touches | Migration | Sequence |
|---|---|---|---|
| **ADR-3** Source link | footer, build version, `/.well-known/source`, self-host docs | none | **1st — launch-blocking** |
| **ADR-2** attribution | find-write paths (`account_id`), display joins via `callsign_history` | maybe tiny | 2nd — before more identity work |
| **ADR-5** tombstones | account/find delete → signed tombstone; `/federation/tombstones`; peer purge | yes (federation) | 3rd — with federation/GDPR hardening |
| **ADR-1** credit | profile aggregation over `account_callsigns` | none | with community polish |
| **ADR-4a/4b** API + push | `api_keys`, `push_subs`, rate-limit/cache, email digest, PWA gating | yes (with `docs/11`) | with `docs/11` |
| **docs/12** sustainability | `accounts.tier`, `entitlements`, `peers`, `payouts`, `ledger` (recognition-only) | **0012** | with `docs/12` |

**Migration numbering:** monetization = **0012**. `docs/11` feature tables (`saved_views`, `api_keys`,
`push_subs`, `cache_fts`) and the federation `tombstones` table take the next free numbers after
`0012`.

---

## ADR-3 spec — "Source" link (AGPL §13 compliance)

**Goal.** Any user of a running instance can reach the exact source the service is running, per
AGPL-3.0 §13. Launch-blocking for the first public deploy.

- **Build-time version stamp.** Inject `VERSION` = `{commit, tag?, builtAt}` at build (Worker + Node
  + web). Source of truth: `git rev-parse HEAD` / `git describe --tags`. Fallback to env
  (`SOURCE_COMMIT`) for CI/containers where git isn't present at build.
- **Well-known route.** `GET /.well-known/source` → JSON `{repo, commit, tag, builtAt, license}` and
  `GET /source` → 302 to the repo tree at that commit (`<repo>/tree/<commit>`). Both on Cloudflare
  and Node (runtime-neutral, beside the federation well-known).
- **Visible link.** A "Source" link in the web footer / About & credits, label showing the short
  commit (`v… · a1b2c3d`), href → `/source`.
- **Self-host instruction.** README/self-host paragraph: operators who modify the code MUST set
  `SOURCE_REPO`/`SOURCE_COMMIT` to *their* published source so the link points at what they actually
  run (that is the §13 obligation, not the upstream repo).
- **SPDX headers.** Begin adding `SPDX-License-Identifier` headers per file incrementally; not a
  blocker for the source link.

**Launch checklist (ADR-3):**
- [ ] Build injects `VERSION` (commit/tag/builtAt) on Worker, Node, and web.
- [ ] `GET /.well-known/source` returns repo+commit+license JSON on both runtimes.
- [ ] `GET /source` 302-redirects to the repo tree at the running commit.
- [ ] Footer/About shows a visible "Source" link with the short commit.
- [ ] Self-host README documents `SOURCE_REPO`/`SOURCE_COMMIT` for modified deployments.
- [ ] (Non-blocking) SPDX headers started across `apps/`, `workers/`, `servers/`.

---

## ADR-5 spec — federation tombstones (GDPR delete propagation)

**Goal.** A delete on one instance removes mirrored copies on peers, signed so peers can trust it,
carrying **no PII**.

- **Schema (federation migration, next free number after `0012`).**
  ```sql
  CREATE TABLE tombstones (
    id          TEXT PRIMARY KEY,     -- uuid of the tombstone
    kind        TEXT NOT NULL,        -- 'account' | 'find' | 'cache'
    target_id   TEXT NOT NULL,        -- namespaced global id of the removed record (NOT a callsign/PII)
    origin      TEXT NOT NULL,        -- emitting instance
    ts          INTEGER NOT NULL,     -- emit time
    sig         TEXT                  -- Ed25519 signature over (kind,target_id,origin,ts)
  );
  CREATE INDEX idx_tombstones_ts ON tombstones(ts);
  ```
  `target_id` is the same namespaced/global id the federation feeds already publish (e.g.
  `instance:find:123`), never a bare callsign or other PII.
- **Emit.** On `DELETE /api/account/:call/delete` (after the existing anonymise/erase) and on
  find/cache deletion, insert a signed tombstone for each removed federated record.
- **Feed.** `GET /federation/tombstones?since=<cursor>` — append-only, Ed25519-signed exactly like
  `/federation/{caches,finds,keys}`. Append the tombstones cursor to the peer sync loop.
- **Apply.** On sync, a subscriber verifies each tombstone's signature against the origin peer's
  published key, then purges any mirrored record whose global id matches `target_id` (and suppresses
  re-mirroring it). Mirror-or-tombstone, last-writer by `ts`.
- **Retention.** Keep tombstones long enough for all peers to converge (e.g. ≥ the longest peer sync
  interval × safety factor; default 180 days). They are tiny and PII-free, so erring long is cheap.
- **Interplay with erasure.** The local erase still anonymises/removes PII immediately; the tombstone
  only carries signed ids so the *propagation* itself introduces no new personal data.

---

## Cross-references
- **ADR-1 / ADR-2** reflected in `docs/10` (identity & community).
- **ADR-4a / ADR-4b** reflected in `docs/11` (API access model + push/email-fallback).
- **migration 0012 + recognition-only + attribution** reflected in `docs/12`.
- **ADR-3 / ADR-5** specced here; ADR-5 extends the federation model in `docs/06` and joins the
  federation feed family in the next-level roadmap (`docs/15-federation-next.md`, T1.3).
