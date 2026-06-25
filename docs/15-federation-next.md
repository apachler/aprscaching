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

**Status — IMPLEMENTED** (migration `0013_peer_trust.sql` · `federation_sync.ts` · federation smoke +9
assertions green): `fed_peers` carries `trust/added_via/approved_at/rep_confirmed/rep_failed`; FED_PEERS
seed as `manual`+`trusted` (a manual peer an operator `blocked` stays blocked across re-seeds),
FED_DISCOVER peers as `discovered`+`unvetted`; `listEnabledPeers` never returns `blocked` peers (no
fetch on sync *or* corroborate); **corroboration counts only `trusted` peers** (closes the T1.2 gap);
`POST /federation/peers/trust` (INGEST_SECRET-gated) lets the operator promote/demote/block and
`GET /federation/peers` exposes trust+reputation. **Deferred:** the `rep_confirmed/rep_failed`
auto-promotion loop (needs a later independent-confirmation signal) and the Settings → Federation UI.

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

**Status — IMPLEMENTED** (`corroborate.ts` · `corroborate_privacy.ts` · `test/corroborate.test.ts` +
`test/corroborate_privacy.test.ts` · federation smoke +5 assertions green). All three pieces landed:

- **Quorum** — `queryPeerCorroboration()` fans out to **`trusted`** peers only (T1.1) **in parallel**
  (3 s per-peer timeout, bounded to 16 peers), and a pure, unit-tested `selectCorroboration(hits, quorum)`
  de-dupes by instance (same instance twice = one voice), enforces **≥ `FED_CORROBORATION_QUORUM` distinct
  instances** (floors at 1 so a 0/NaN config never disables the gate), and returns the closest evidence
  annotated with `corroborators` (the instance count).
- **Endpoint hardening** *(done)* — `handleCorroborate` gains an optional **shared-secret allowlist**
  (`FED_CORROBORATION_SECRET` → require `x-fed-secret`), best-effort **in-memory rate limiting** (per-IP +
  per-callsign fixed window), **negative-result memoization** (30 s), and a **bounded fan-out** on the ask
  side. The in-memory limiters are per-isolate (weaker on Workers' fan-out) — the secret + coarse responses
  are the load-bearing guarantees.
- **Privacy coarsening** *(done; docs/06 #4)* — the **asker** snaps its query center to a **grid square**
  and buckets the **time window** (radius widened by the grid half-diagonal so a snap never misses); the
  **answerer** coarsens its response **unconditionally** — a distance **bucket** + a bucketed ts + the
  corroborating instance, **never the exact IGate** unless `FED_REVEAL_IGATE` is set. So even a prober
  sending exact coordinates gets only a coarse answer: the endpoint is no longer a precise "where was OE8APR
  at time T" oracle. Grid/bucket sizes are tunable (`FED_CORROBORATION_GRID_DEG` ≈ 550 m,
  `…_TIME_BUCKET_SEC` 600, `…_DIST_BUCKET_M` 100 by default).
- *Worth:* this is the real anti-spoofing upgrade to the headline trust feature — Tier A becomes
  "corroborated by the network," resistant to a single colluding instance, and not abusable as a tracker.

### T1.3 Signed tombstones (ADR-5 integration)
GDPR deletes and removed caches propagate. Full spec in `docs/14`; here it joins the feed family:
`tombstones` table, `GET /federation/tombstones?since=<cursor>` (Ed25519-signed like the others), peer
verify-and-purge on sync, PII-free (signed global ids + ts only), long retention for convergence.

**Status — IMPLEMENTED** (migration `0014_tombstones.sql` · `tombstones.ts` · `federation_sync.ts` ·
federation smoke +9 assertions green): a GDPR account-delete now emits **PII-free find tombstones**
(`emitTombstones`, signed at serve time by `GET /federation/tombstones`, cursor = monotonic `seq`); the
peer sync loop pulls tombstones **first**, verifies each against the origin's key, and **purges the
matching `remote_caches`/`remote_finds` by global id**, recording it in `remote_tombstones` to suppress
re-mirroring (`accept()` gate). Caches propagate their removal via **archive + `updated_at` bump** (they
re-serve through the caches feed and drop off peer maps), so no cache tombstone is needed on
account-delete. Retention GC runs in `runScheduled` (`TOMBSTONE_TTL_DAYS`, default 180). The apply path
already handles `kind='cache'` for when an explicit cache-delete endpoint lands.
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

### T2.3 Joining from behind NAT / firewall (outbound-only peers)  *(serves docs/06 §6 #4 replication, §9 mesh)*
**Problem.** Federation is **pull-based**: a contributing peer must be *inbound-reachable* at a URL.
Others pull its `GET /federation/{caches,finds,keys}` and `POST` its `/federation/corroborate`. A box
behind CGNAT / a dynamic IP / a firewall, with no FQDN, can pull (outbound works) and can get *its own*
finds to Tier A (it queries reachable peers), but **cannot be mirrored and cannot contribute
corroboration** — nobody can reach it. So today it's a read/verify-only leaf, not a full peer, and its
caches/finds + independent IGate hearings never reach the commons. Three ways to let it fully join,
in increasing effort — the first needs **no code** and already meets the requirement for most operators:

- **(0) Reverse tunnel — supported today, zero new code.** A free **Cloudflare Tunnel** (`cloudflared`,
  already the `docs/23` Topology 1 recipe), Tailscale Funnel, or ngrok gives the box a stable public
  hostname + TLS over an *outbound* tunnel — **no FQDN-you-own, no static IP, no port-forward, no
  firewall changes**. Through it the box is a **full peer** (feeds *and* corroboration work). This is the
  recommended firewalled-peer path and what `fed_peers.url` should point at.
- **(1) Push-to-hub for feeds — cheap interim (mirroring only).** Because every record is **Ed25519-signed
  by its origin and signatures are portable**, a NAT'd peer can *push* its signed caches/finds to a
  reachable **home/hub** peer over an outbound connection; the hub **re-serves them in its own feed with
  the original `signer` preserved**. Consumers verify the origin's signature regardless of who served it —
  no trust delegation, no forgery surface. The mirror path *already* preserves `rec.signer` and verifies
  against the signer's published key (`federation_sync.ts:accept`); the only missing pieces are a
  **`POST /federation/submit`** (signed-envelope intake, signer-key-verified, rate-limited) on the hub and
  a **re-host-with-original-signer** emit in `handleFederationCaches/Finds`. Restores **commons
  visibility** for outbound-only peers. Does **NOT** solve live corroboration (that needs the box's live
  RF positions, which it isn't shipping).
- **(2) Gateway-as-relay / rendezvous — full solution.** The NAT'd peer opens a **persistent outbound
  WebSocket** to a reachable rendezvous instance; the rendezvous **relays both feed-pull and corroboration
  queries** back over that socket (request/response framed; the peer answers from its own DB). This is the
  same **"gateway-as-cloud-relay (ECHOCAT pattern; no port-forward)"** already reserved in `docs/20` for
  remote ingest control — federation reuses the seam. It is the *only* option that lets a firewalled box
  **contribute corroboration** without a tunnel. One always-on outbound WS per relayed peer → gate behind
  an explicit opt-in and prefer (0) where a tunnel is acceptable (cost rules: no firehose, request/response
  only, the relay never upgrades trust — it's pure transport, quorum still counts *distinct instances*).
- *Worth:* makes the "operator-owned box, anywhere" promise real for the home/off-the-shelf case the
  ingest-locality rule centers on — a Pi behind CGNAT becomes a first-class contributing peer, not just a
  consumer. **Reachability is transport, never trust:** a relayed/tunnelled packet is exactly as trusted as
  a directly-served one (Tier still set by `verify.ts` + quorum), consistent with `docs/22`'s "transport
  convenience ≠ trust uplift."

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
- `fed_peers` += `trust, added_via, approved_at, rep_confirmed, rep_failed` (T1.1 — **landed as
  `0013_peer_trust.sql`**; `0012` stays reserved for monetization per CLAUDE.md, gap is intentional)
- `tombstones` + `remote_tombstones` tables + `fed_peers.tombstones_cursor` + `GET /federation/tombstones`
  (T1.3 / ADR-5; **landed as `0014_tombstones.sql`**)
- `caches` += `fed_scope` (T3.3)
- key-rotation columns/feed (T4.1); registry is external/signed, no local schema required

## API additions
`POST /federation/notify` (T2.1) · `GET /federation/tombstones` (T1.3, **shipped**) · `account-move` feed type
(T3.2) · extended `/.well-known` (`publicKeys[]`, `protocolVersions`, richer `capabilities`) (T2.2/T4.1)
· `GET /federation/peers` returns trust+reputation + `POST /federation/peers/trust` operator promote/block
(T1.1, **shipped**). Corroboration query/response shape changes to grid+bucket (T1.2, **shipped** — coarse distance + bucketed ts + instance, no exact IGate; optional
`x-fed-secret` allowlist). Public read API gains origin+trust-tagged mirrored caches (T3.1). `POST /federation/submit`
(signed-envelope intake for push-to-hub) + a relay/rendezvous WS endpoint (T2.3).

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
- **F4 (trust — launch-gating before opening the network) — COMPLETE:** T1.1 peer tiers + quarantine
  **(done)** · T1.2 corroboration quorum + hardening + privacy coarsening **(done)** · T1.3 signed
  tombstones **(done)**.
- **F5 (reach):** T2.1 gossip ping · T2.2 generalized envelope/capability negotiation · T2.3 NAT/firewall
  join (tunnel today → push-to-hub interim → rendezvous relay).
- **F6 (commons):** T3.1 federated catalog in API+map · T3.2 account-move record · T3.3 redaction.
- **F7 (governance):** T4.1 key rotation · T4.2 instance registry · T4.3 observability.

## Acceptance (abbreviated, per tier)
- **T1.1:** an unvetted/auto-discovered peer's caches are mirrored but hidden from the default map and
  excluded from verification until promoted; a blocked peer is never fetched.
- **T1.2:** a find upgrades to Tier A only when ≥ quorum distinct trusted instances corroborate; the
  corroboration endpoint rate-limits abuse and answers in coarse buckets, never exact coords/IGate
  (**met**: smoke asserts a bucketed distance, hidden IGate, no callsign on the wire, and a 429 under load).
- **T1.3:** deleting an account on instance A removes its mirrored copies on peer B after sync — the
  tombstone is signed, verifies against A's key, and carries no callsign/PII (**met**: smoke asserts the
  TOMB1 cache drops off B's map and the find tombstone is signed + PII-free).
- **T2.1:** a new find on A is mirrored/corroborated on B within seconds of a notify, not a poll cycle.
- **T2.3:** a peer with no inbound reachability joins as a full contributor — its caches/finds appear on
  peers' maps and its IGate hearings count toward others' quorum — via a tunnel (today), or push-to-hub
  (mirroring) / rendezvous relay (corroboration); a relayed packet is no more trusted than a direct one.
- **T3.1:** the public map/API shows trusted-peer caches with origin attribution; unvetted are opt-in.
- **T3.2:** moving OE8APR from A to B re-homes finds and the network attributes them to the account.
- **T3.3:** a `local-only` cache never appears in any peer's mirror; `hint` never crosses the wire.
- **T4.1:** rotating the instance key keeps past signatures verifiable and new records trusted.
