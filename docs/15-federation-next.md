# Federation — next level (F4+)

Status: **Backlog spec.** Takes the live federation (F0–F3) from "mirror whatever signed peers say"
to "a network that resists a hostile instance, propagates deletes, surfaces a global catalog, and is
operable at scale." Build against `.claude/rules/ui-ux.md` + `.claude/rules/css.md` and the cost
rules. Resolves docs/06 open questions **#2 (namespace authority)**, **#3 (open vs peer-approved)**,
**#4 (position privacy)**; integrates ADR-5 tombstones from `docs/14`.

## What exists today (recap — see `workers/gateway/src/federation*.ts`, `corroborate.ts`)
- **Discovery:** `GET /.well-known/aprscaching` (protocol `aprscaching-federation/0.1`, instance id,
  capabilities, Ed25519 public key, peers).
- **Signed feeds (F1):** `/federation/{caches,finds,keys}?since=<cursor>`; records
  `{type,id,data,cursor,sig,signer}`, `sig` = Ed25519 over canonical `stableStringify({type,id,data})`,
  `id` = `instance:cache:N`. Only `source='native'` caches federate; cursors are idempotent high-water marks.
- **Mirroring (F2):** `syncAllPeers()` pages each peer (per-peer cursors in `fed_peers`), **verifies
  every signature**, upserts into `remote_caches/remote_finds/remote_keys` (display-only). `FED_DISCOVER`
  adopts peers-of-peers. Trigger `POST /federation/sync` or 5-min interval; status `GET /federation/peers`.
- **Per-callsign signing (F0):** finds carry `authorKey/authorSig/signedAt`; callsign→key bindings ride
  the signed `keys` feed → authorship provable by anyone, independent of the instance signature.
- **Cross-instance corroboration (F3):** `POST /federation/corroborate` answers "did you independently
  hear `<call>` on RF near `<lat,lon>` in `<window>`, via an IGate the logger doesn't control?" When a
  find can't reach Tier A locally, `queryPeerCorroboration()` asks peers (**first match wins**) → Tier A
  `aprs_rf_peer`.

**Gaps this doc closes:** federation trusts any signed peer wholesale; corroboration is an
unauthenticated public presence oracle with first-match (a single colluding peer mints Tier A); no
delete propagation; pull-only polling; feeds leak `hint`/`description`; single static key; no namespace
authority.

---

## Tier 1 — Trust & safety (launch-gating; do before opening the network to strangers)

### T1.1 Peer trust tiers + quarantine  *(resolves docs/06 #3)*
Federation becomes **peer-approved by default, open-pull opt-in.** Each peer carries a trust level;
records inherit their origin peer's trust at read time.

- **Schema** — extend `fed_peers`:
  ```sql
  ALTER TABLE fed_peers ADD COLUMN trust TEXT NOT NULL DEFAULT 'unvetted'; -- trusted | unvetted | blocked
  ALTER TABLE fed_peers ADD COLUMN added_via TEXT;        -- manual | discovered
  ALTER TABLE fed_peers ADD COLUMN approved_at INTEGER;
  ALTER TABLE fed_peers ADD COLUMN rep_confirmed INTEGER NOT NULL DEFAULT 0; -- corroborations later confirmed
  ALTER TABLE fed_peers ADD COLUMN rep_failed    INTEGER NOT NULL DEFAULT 0; -- corroborations contradicted
  ```
- **Behavior** — `manual` peers (in `FED_PEERS`) default `trusted`; `FED_DISCOVER` peers default
  `unvetted`; `blocked` are never fetched. **Unvetted records are mirrored but flagged** — excluded from
  verification (T1.2) and from the default map, shown only behind an explicit "include unvetted network
  data" toggle (ui-ux §2, off by default). Reputation (`rep_confirmed/rep_failed`) is updated when a
  peer's corroboration is later independently confirmed or contradicted; an operator can promote/demote
  or auto-promote past a threshold.
- **API/UI** — `GET /federation/peers` returns trust+reputation; an operator **Settings → Federation**
  group lists peers with trust controls (promote/block), grouped + collapsible.
- *Worth:* the difference between "a friend's map" and "a network a stranger can't poison." Today a
  single `FED_PEERS` entry (or an auto-discovered peer) can inject fake caches/finds onto everyone's map.

### T1.2 Corroboration quorum + hardening  *(resolves docs/06 #4)*
Tier A via the network should mean **multiple independent instances agree**, not "the first peer said yes."

- **Quorum** — `queryPeerCorroboration()` collects evidence from peers **in parallel**, keeps only
  `trusted` peers (T1.1), de-dupes by instance + IGate (independence), and upgrades to Tier A only at
  **≥ N distinct instances** (config `FED_CORROBORATION_QUORUM`, default 1 for a small network → raise as
  it grows). Records which instances corroborated (audit).
- **Endpoint hardening** — `handleCorroborate` gains: rate-limiting (per-IP + per-peer), an optional
  shared-secret/allowlist so only known peers can probe, negative-result memoization, and a bounded
  fan-out budget.
- **Privacy coarsening** *(docs/06 #4)* — queries carry a **grid square + time bucket**, not exact
  lat/lon/second; responses return yes/no + coarse distance bucket + corroborating instance, **not the
  exact IGate** unless both peers opt in. The endpoint stops being a precise public "where was OE8APR at
  time T" oracle.
- *Worth:* this is the real anti-spoofing upgrade to the headline trust feature — Tier A becomes
  "corroborated by the network," resistant to a single colluding instance, and not abusable as a tracker.

### T1.3 Signed tombstones (ADR-5 integration)
GDPR deletes and removed caches propagate. Full spec in `docs/14`; here it joins the feed family:
`tombstones` table, `GET /federation/tombstones?since=<cursor>` (Ed25519-signed like the others), peer
verify-and-purge on sync, PII-free (signed global ids + ts only), long retention for convergence.
- *Worth:* EU-mandatory, and keeps the mirrored catalog correct (no zombie caches/finds).

---

## Tier 2 — Reach & freshness (network-effect multipliers)

### T2.1 Gossip ping (push-to-pull)
A tiny `POST /federation/notify {instance, types, maxCursor}` lets a peer say "I have new records past
X — come pull." Receivers debounce and trigger an incremental `syncPeer` for that origin instead of
waiting for the 5-min poll. Authenticated to known peers; coalesced.
- *Cost-safe:* it's a ping, not a stream — no firehose across instances, stays inside the cost rules
  (no new always-on connections; reuses the existing pull path).
- *Worth:* near-real-time cross-instance corroboration (a find verifies in seconds) and live mirrored
  caches, without polling cost.

### T2.2 Generalized feed envelope + capability negotiation
Lift the record envelope (`{type,id,data,cursor,sig,signer}`) and the cursor/verify machinery into one
generic feed so new record types (tombstones, account-moves T3.2, presence digests, badges) ride
existing, tested plumbing. `/.well-known` advertises `capabilities` + `protocolVersions`; consumers
negotiate and skip unknown types forward-compatibly.
- *Worth:* future federation features need no new endpoints or bespoke verify code; older peers don't break.

---

## Tier 3 — Data-commons value (turn mirroring into user-visible payoff)

### T3.1 Federated catalog in the read API + map
Surface mirrored caches (already in `remote_caches`) through the public read API (`docs/11` / ADR-4a)
and the map layer switcher, each tagged with **origin instance + trust flag** (unvetted hidden by
default per T1.1). A combined bbox/search spans native + trusted-mirrored.
- *Worth:* delivers the "one global map" promise — today mirroring happens but barely surfaces to users.

### T3.2 Account-move as a signed federation record  *(pairs with ADR-2)*
`/api/account/{bundle,move,import}` already exist. Publish the **move** as a signed record on a new feed
type so finds re-home to the destination instance and the network learns `OE8APR` changed homes. Device-key
signatures (F0) already make the finds portable; federation just needs to announce the move and let peers
re-point attribution via `account_id` (ADR-2), never the bare call string.
- *Worth:* people aren't locked to one instance; identity + history travel with the person.

### T3.3 Owner-controlled field redaction
Don't federate spoiler fields: drop or coarsen `hint` in feeds, and honor a per-cache
`fed_scope` (`public | unlisted | local-only`) so owners choose whether a cache federates at all.
- **Schema:** `ALTER TABLE caches ADD COLUMN fed_scope TEXT NOT NULL DEFAULT 'public';`
  `cacheData()` omits `hint` (and `description` when `unlisted`); `handleFederationCaches` filters
  `fed_scope='local-only'`.
- *Worth:* protects game integrity (no network-wide hint leak) and owner choice.

---

## Tier 4 — Governance & operations (scale without fragmenting)

### T4.1 Key rotation + multi-key + revocation
`/.well-known` publishes `publicKeys: [{x, since, until?}]` (current + previous); a signed **rotation
record** announces a new key signed by the old. Consumers accept records signed by any non-revoked
published key within its validity window; a revocation entry invalidates a leaked key without discarding
history.
- *Worth:* operational hygiene — rotate or recover from a key leak without breaking every past signature.

### T4.2 Instance registry / namespace authority  *(resolves docs/06 #2)*
A lightweight, **signed instance registry** (a public repo/feed mapping `instance-prefix → {url, key,
operator, aprsCall}`) bootstraps discovery and prevents prefix collisions / instance-name spoofing.
The **`aprsCall`** binding (the peer's `<licensedCall>-<SERVICE_SSID>` APRS-IS service address, per
`docs/19`) is what makes a peer directly addressable *as a network node* — so the platform/any peer
can resolve and message it on APRS. Opt-in; instances can still peer directly without it. Could be
DNS-anchored (`TXT` at the instance domain) or a community-maintained signed list.
- *Worth:* as the network grows, namespaced ids (`instance:cache:N`) must not collide and `signer` names
  must not be forgeable.

### T4.3 Federation observability
Per-feed sync metrics (records mirrored, lag, error rates), a peer health/reputation surface in the
operator Workbench, and structured `last_error`. Extends the existing `fed_peers.last_sync/last_error`.
- *Worth:* you can't operate a network you can't see; reputation (T1.1) needs measured inputs.

---

## Not worth it (explicit non-goals)
CRDTs / consensus / blockchain. Append-only signed logs + origin-namespaced ids already give convergence
and tamper-evidence; anything heavier fights the cost model for no real gain. Streaming the RF firehose
across instances is also out (cost) — corroboration stays on-demand (T1.2) with gossip (T2.1) for freshness.

## Schema additions (new migrations after `0012`; numbers assigned at implementation, never renumber)
- `fed_peers` += `trust, added_via, approved_at, rep_confirmed, rep_failed` (T1.1)
- `tombstones` table + `GET /federation/tombstones` (T1.3 / ADR-5; per `docs/14`)
- `caches` += `fed_scope` (T3.3)
- key-rotation columns/feed (T4.1); registry is external/signed, no local schema required

## API additions
`POST /federation/notify` (T2.1) · `GET /federation/tombstones` (T1.3) · `account-move` feed type
(T3.2) · extended `/.well-known` (`publicKeys[]`, `protocolVersions`, richer `capabilities`) (T2.2/T4.1)
· `GET /federation/peers` returns trust+reputation (T1.1). Corroboration query/response shape changes to
grid+bucket (T1.2). Public read API gains origin+trust-tagged mirrored caches (T3.1).

## Rule / cost / privacy compliance
- **Trust-model invariant:** a session or a mirror NEVER upgrades a find's tier; only quorum
  corroboration (T1.2) does, and only from `trusted` peers. Position tiers stay independent of account
  verification.
- **Cost:** gossip is a ping not a stream; sync stays incremental + capped (`MAX_PAGES`); no new
  always-on connections; unvetted data isn't stored beyond mirror rows already bounded by cursors.
- **Privacy/DSGVO:** corroboration coarsened to grid+bucket; tombstones carry no PII; redaction (T3.3)
  keeps hints/owner-private data off the wire.
- **ui-ux:** Settings → Federation is a grouped, toggle-gated, collapsible operator surface; "include
  unvetted network data" is an explicit off-by-default switch; none of this reaches the cacher's default map.

## Milestone / sequence
- **F4 (trust — launch-gating before opening the network):** T1.1 peer tiers + quarantine · T1.2
  corroboration quorum + hardening · T1.3 tombstones.
- **F5 (reach):** T2.1 gossip ping · T2.2 generalized envelope/capability negotiation.
- **F6 (commons):** T3.1 federated catalog in API+map · T3.2 account-move record · T3.3 redaction.
- **F7 (governance):** T4.1 key rotation · T4.2 instance registry · T4.3 observability.

## Acceptance (abbreviated, per tier)
- **T1.1:** an unvetted/auto-discovered peer's caches are mirrored but hidden from the default map and
  excluded from verification until promoted; a blocked peer is never fetched.
- **T1.2:** a find upgrades to Tier A only when ≥ quorum distinct trusted instances corroborate; the
  corroboration endpoint rejects unauthenticated abuse and answers in grid+bucket, not exact coords.
- **T1.3:** deleting an account/cache on instance A removes its mirrored copies on peer B after sync.
- **T2.1:** a new find on A is mirrored/corroborated on B within seconds of a notify, not a poll cycle.
- **T3.1:** the public map/API shows trusted-peer caches with origin attribution; unvetted are opt-in.
- **T3.2:** moving OE8APR from A to B re-homes finds and the network attributes them to the account.
- **T3.3:** a `local-only` cache never appears in any peer's mirror; `hint` never crosses the wire.
- **T4.1:** rotating the instance key keeps past signatures verifiable and new records trusted.
