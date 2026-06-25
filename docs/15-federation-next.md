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
`GET /federation/peers` exposes trust+reputation.

**Reputation loop — DONE** (`corroborate.ts` · `shouldAutoPromote` unit-tested · smoke +1): when a find
reaches Tier A, every peer whose corroboration was thus independently confirmed earns `rep_confirmed++`
(measured in `queryPeerCorroboration`). With `FED_AUTO_PROMOTE=N` set (default 0 = off), `unvetted` peers
are *also* probed — **advisorily, never counting toward quorum** — so they can EARN trust by agreeing with
confirmed corroborations, and one crosses to `trusted` automatically once `rep_confirmed ≥ N` with no
contradictions (`shouldAutoPromote`). Default behaviour + cost are unchanged (trusted-only) until an
operator opts in. **Still deferred:** an automatic *contradiction* signal for `rep_failed`, and a
dedicated Settings → Federation UI (the Workbench → Federation group now shows trust + health + reputation).

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
A tiny `POST /federation/notify {instance}` lets a peer say "I have new records — come pull." Receivers
debounce and trigger an incremental `syncPeer` for that origin instead of waiting for the 5-min poll.

**Status — IMPLEMENTED** (`gossip.ts` · `test/gossip.test.ts` · federation smoke +3 assertions green):
the **receiver** `POST /federation/notify` looks up the named instance among the peers it follows
(enabled, non-blocked), coalesces (a 2 s per-instance cooldown), and triggers the incremental sync off
the response path via `ctx.waitUntil` → `syncPeerByInstance`. The **emitter** fires from `handle()`
after any successful *federated write* (`isFederatedWrite`: cache create, find log, key register,
account delete), coalescing a burst into one "come pull" round to the instance's known peers. The pull
stays signature-verified, so a forged notify only causes a (coalesced) pull from an already-trusted
peer — the signed feed remains the security boundary, not the ping. `/.well-known` advertises the
`notify` capability. **Deferred:** a `types`/`maxCursor` hint to scope the pull (today it syncs all
feeds) — folds into the T2.2 capability envelope.
- *Cost-safe:* it's a ping, not a stream — no firehose across instances, stays inside the cost rules
  (no new always-on connections; reuses the existing pull path).
- *Worth:* near-real-time cross-instance corroboration (a find verifies in seconds) and live mirrored
  caches, without polling cost.

### T2.2 Generalized feed envelope + capability negotiation
Lift the record envelope (`{type,id,data,cursor,sig,signer}`) and the cursor/verify machinery into one
generic feed so new record types (tombstones, account-moves T3.2, presence digests, badges) ride
existing, tested plumbing. `/.well-known` advertises `capabilities` + `protocolVersions`; consumers
negotiate and skip unknown types forward-compatibly.

**Status — IMPLEMENTED** (`federation.ts:serveFeed` + `FeedServeDef` · `federation_sync.ts:syncFeed` +
`SYNC_DEFS` + `negotiateFeeds` · `test/negotiate.test.ts` · smoke +3 assertions; the 4 serve handlers
and 4 sync consumers collapsed to one generic path each). The **serve** side is one `serveFeed(def)` —
select rows → shape `{type,id,cursor,data}` → sign → standard envelope; caches/finds/keys/tombstones are
now just `FeedServeDef`s (a new feed = one def, no endpoint/signing code). The **sync** side is one
`syncFeed(def)` over a `SYNC_DEFS` table (tombstones-first preserved). `/.well-known` advertises
`protocolVersions: ["0.1","0.2"]` + the full `capabilities`; the consumer **negotiates** (`negotiateFeeds`):
a peer that speaks our version → pull only what it advertises; a legacy peer → try every known feed with
a **404-as-skip** fallback, so a newer consumer never fails its whole sync against an older peer.
**Deferred:** the gossip `types`/`maxCursor` scoping hint (T2.1) now has a clean home in this envelope.
- *Worth:* future federation features need no new endpoints or bespoke verify code; older peers don't break.

### T2.3 Joining from behind NAT / firewall (outbound-only peers)  *(serves docs/06 §6 #4 replication, §9 mesh)*
**Problem.** Federation is **pull-based**: a contributing peer must be *inbound-reachable* at a URL.
Others pull its `GET /federation/{caches,finds,keys}` and `POST` its `/federation/corroborate`. A box
behind CGNAT / a dynamic IP / a firewall, with no FQDN, can pull (outbound works) and can get *its own*
finds to Tier A (it queries reachable peers), but **cannot be mirrored and cannot contribute
corroboration** — nobody can reach it. So today it's a read/verify-only leaf, not a full peer, and its
caches/finds + independent IGate hearings never reach the commons. Three ways to let it fully join,
in increasing effort — the first needs **no code** and already meets the requirement for most operators:

**Status — paths (0) + (1) DONE; (2) deferred.** (0) is documented (`docs/23` Topology 1). (1) push-to-hub
shipped: `POST /federation/submit` (`federation_sync.ts`) + the spoke-side `pushToHub` (wired into
`runScheduled`), `test`-covered by the federation smoke (+6 assertions). (2) the persistent-WS rendezvous
relay — the only tunnel-free path that restores *corroboration* contribution — remains deferred (large,
runtime-divergent infra; needs the instance-key registry T4.2 for downstream re-serving).

- **(0) Reverse tunnel — supported today, zero new code.** A free **Cloudflare Tunnel** (`cloudflared`,
  already the `docs/23` Topology 1 recipe), Tailscale Funnel, or ngrok gives the box a stable public
  hostname + TLS over an *outbound* tunnel — **no FQDN-you-own, no static IP, no port-forward, no
  firewall changes**. Through it the box is a **full peer** (feeds *and* corroboration work). This is the
  recommended firewalled-peer path and what `fed_peers.url` should point at.
- **(1) Push-to-hub for feeds — DONE (push-mode mirroring).** A spoke pushes its **signed** records to a
  reachable hub's **`POST /federation/submit`** (secret-gated via `FED_SUBMIT_SECRET`, optional instance
  allowlist `FED_SUBMIT_INSTANCES`); the hub verifies each record against the **supplied key**, requires
  `signer === submitter` (so a spoke can only contribute records as *itself*, never impersonate another
  instance), and **mirrors them into the same `remote_*` tables as pull-sync** — display-only, idempotent
  by global id. The spoke side is `pushToHub` (`FED_HUB_URL` + the shared secret), incremental via in-memory
  cursors, run from `runScheduled` and reusing the T2.2 `buildFeed` to produce the same signed records.
  This restores **commons visibility** for an outbound-only peer at its hub (e.g. the flagship `.net`
  instance most users see). It does **NOT** solve live corroboration (the spoke isn't shipping its RF
  positions), and the hub does **not re-serve** submitted records to *its* downstream pull-peers — that
  downstream re-host needs the instance-key registry (T4.2), so submitted records stop at the hub, exactly
  like any other mirror (`federation_sync.ts` header: mirrors are display-only, never re-published).
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

**Status — IMPLEMENTED** (`caches.ts:handleCachesInBBox` · `MapCache.originTrust` · web `FilterPanel`
toggle + `RemoteCachePanel` badge · federation smoke +5 assertions). `GET /api/caches?bbox=` now
**LEFT JOINs `remote_caches` to `fed_peers`** at read time and applies the T1.1 trust policy: native
always shown; `trusted`-origin mirrors shown by default; `unvetted` (auto-discovered) hidden unless
`?includeUnvetted=1`; `blocked` never surfaced. Because trust is a read-time join, promoting/blocking a
peer takes effect immediately with no re-mirror. Each cache carries `originTrust`
(`native | trusted | unvetted`); push-to-hub spokes (T2.3) are registered `trusted` so their caches
surface by default. The web map gains an off-by-default **"include unvetted network data"** switch
(`FilterPanel`, ui-ux §2) and an `unvetted` badge on the mirrored-cache panel. **Deferred:** a dedicated
search endpoint (none exists yet — the bbox map is the read surface) and per-API-key read limits (ADR-4a).
- *Worth:* delivers the "one global map" promise — today mirroring happens but barely surfaces to users.

### T3.2 Account-move as a signed federation record  *(pairs with ADR-2)*
`/api/account/{bundle,move,import}` already exist. Publish the **move** as a signed record on a new feed
type so finds re-home to the destination instance and the network learns `OE8APR` changed homes. Device-key
signatures (F0) already make the finds portable; federation just needs to announce the move and let peers
re-point attribution via `account_id` (ADR-2), never the bare call string.

**Status — IMPLEMENTED** (migration `0016_account_moves.sql` · `account.ts:ACCOUNT_MOVE_FEED` +
publish-on-import · `federation_sync.ts:upsertRemoteAccountMove` + `SYNC_DEFS` · smoke +5 assertions).
On a successful `/api/account/import` (the target verified the device-key migration assertion), the
**target publishes a signed `account-move` record** — "this callsign now homes here, from `<source>`" —
on `GET /federation/account-moves`, riding the T2.2 generalized envelope. Peers consume it through the
same `syncFeed` path and record the latest home per callsign in `remote_account_moves` (last-writer by
ts), gated by the same per-peer trust + signature verification as every other feed. `/.well-known`
advertises the `moves` capability; the sync summary reports a `moves` count. **Deferred:** surfacing
"homed at `<instance>`" in the profile/station UI and re-homing mirrored find attribution live (the data
is now present in `remote_account_moves` for that follow-up).
- *Worth:* people aren't locked to one instance; identity + history travel with the person.

### T3.3 Owner-controlled field redaction
Don't federate spoiler fields: drop or coarsen `hint` in feeds, and honor a per-cache
`fed_scope` (`public | unlisted | local-only`) so owners choose whether a cache federates at all.

**Status — IMPLEMENTED** (migration `0015_fed_scope.sql` · `federation.ts:cacheData`/`CACHE_FEED` ·
`caches.ts` create/update + `MapCache`/`CacheSummary.fedScope` · web `HidePanel` scope picker · smoke +5
assertions). The **hint NEVER federates** (dropped from `cacheData` unconditionally — leak-proof);
`unlisted` additionally withholds `description`; `local-only` is filtered out of `CACHE_FEED` entirely.
Owners set the scope on the hide form (a `public | unlisted | local-only` segmented control, default
public). **Retraction:** flipping an already-federated cache to `local-only` emits a **cache tombstone**
(T1.3) so peers purge their mirrored copy; `public→unlisted` re-propagates the redacted version via the
bumped `updated_at`. Caveat: re-widening a `local-only` cache later won't un-suppress it on peers (the
tombstone is sticky) — errs toward privacy; re-create to re-share.
- **Schema:** `ALTER TABLE caches ADD COLUMN fed_scope TEXT NOT NULL DEFAULT 'public';`
- *Worth:* protects game integrity (no network-wide hint leak) and owner choice.

---

## Tier 4 — Governance & operations (scale without fragmenting)

### T4.1 Key rotation + multi-key + revocation
`/.well-known` publishes `publicKeys: [{x, since, until?}]` (current + previous); a signed **rotation
record** announces a new key signed by the old. Consumers accept records signed by any non-revoked
published key within its validity window; a revocation entry invalidates a leaked key without discarding
history.

**Status — IMPLEMENTED** (`federation.ts` multi-key publish/verify · `federation_sync.ts` key-set verify ·
`tools/fedkey/rotatekey.mjs` · `test/keyrotation.test.ts` · smoke +2 assertions; no migration — keys live
in config). `/.well-known` now publishes `publicKeys: [{x,since?,until?,revoked?}]` (current from
`FED_PRIVATE_KEY` + `FED_KEY_HISTORY`) and `rotations: [{key,prevKey,at,sig}]` (`FED_ROTATIONS`); the legacy
single `publicKey` stays for old peers. The **consumer verifies each record against ANY active key**
(`importActiveKeys` → `accept` loops the set) — so an instance can rotate without breaking federation
(serve-time signing means feeds re-sign with the current key; the window covers in-flight consumers), and a
**revoked key is dropped from the accept set** (a leaked key is rejected immediately). `activeFedKeys` (window
+ revocation filter) and `verifyRotationRecord` (continuity: new key vouched by old) are pure + unit-tested;
`rotatekey.mjs` mints the new key + history + a verifying rotation record in one step.
- *Worth:* operational hygiene — rotate or recover from a key leak without breaking every past signature.

### T4.2 Instance registry / namespace authority  *(resolves docs/06 #2)*
A lightweight, **signed instance registry** (a public repo/feed mapping `instance-prefix → {url, key,
operator, aprsCall}`) bootstraps discovery and prevents prefix collisions / instance-name spoofing.
The **`aprsCall`** binding (the peer's `<licensedCall>-<SERVICE_SSID>` APRS-IS service address, per
`docs/19`) is what makes a peer directly addressable *as a network node* — so the platform/any peer
can resolve and message it on APRS. Opt-in; instances can still peer directly without it. Could be
DNS-anchored (`TXT` at the instance domain) or a community-maintained signed list.

**Status — IMPLEMENTED** (`federation.ts` registry verify/enforce · `tools/fedkey/signregistry.mjs` ·
`test/registry.test.ts` · smoke +2; no migration — registry lives in config). A registry **authority**
signs a doc `{entries:[{instance,url?,key?,operator?,aprsCall?}],at,sig}`; consumers set `FED_REGISTRY` +
the authority's `FED_REGISTRY_KEY` and `loadRegistry` parses + **verifies** it (a forged/unsigned registry
is ignored). **Anti-spoof enforcement:** in `syncPeer`, if the registry binds the peer's instance to a key,
the peer's published active keys MUST include it — else the sync throws (`registryKeyAllowed`), so nobody
can impersonate a known instance id; an unregistered instance falls back to TOFU. The registry also **seeds
discovery** (entries → `unvetted` peers, `added_via='registry'`, carrying the bound key). Instances
self-publish `operator` + `aprsCall` in `/.well-known`; `GET /federation/registry` exposes the verified view
+ self-entry. `signregistry.mjs` signs a registry (fresh or reused authority key) in one step. `verifyRegistry`
+ `registryKeyAllowed` are pure + unit-tested. **Deferred:** the `aprsCall`-driven APRS addressing itself
(ties to `docs/19`) and a DNS-`TXT` anchor as an alternative source.
- *Worth:* as the network grows, namespaced ids (`instance:cache:N`) must not collide and `signer` names
  must not be forgeable.

### T4.3 Federation observability
Per-feed sync metrics (records mirrored, lag, error rates), a peer health/reputation surface in the
operator Workbench, and structured `last_error`. Extends the existing `fed_peers.last_sync/last_error`.

**Status — IMPLEMENTED** (migration `0017_fed_observability.sql` · `federation_sync.ts` metrics +
`handleFederationPeers` health · web `WorkbenchPanel` Federation group · smoke +3 assertions). Each sync
records `last_ok` (last success → lag = now − last_ok), `sync_ok`/`sync_err` counts, cumulative
`mirrored_total`, and `last_counts` (the per-feed breakdown JSON). `GET /federation/peers` now derives a
`health` (`ok | error | new | blocked`) + `errorRate` per peer so an operator scans state without doing
the math; the **Workbench → Federation** group lists each peer with a health badge, trust, "synced N ago",
mirrored total, error rate, and the last error. **Deferred:** the rep_confirmed/rep_failed
auto-promotion loop — now has its measured inputs (T1.1 follow-up).
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
- `caches` += `fed_scope` (T3.3 — **landed as `0015_fed_scope.sql`**)
- `account_moves` + `remote_account_moves` tables + `fed_peers.moves_cursor` (T3.2 — **landed as `0016_account_moves.sql`**)
- key rotation (T4.1) is **config-only** (`FED_KEY_HISTORY`/`FED_ROTATIONS`), no local schema — **done**;
  registry (T4.2) is external/signed config (`FED_REGISTRY`/`FED_REGISTRY_KEY`), no local schema — **done**
- `fed_peers` += `last_ok, sync_ok, sync_err, mirrored_total, last_counts` (T4.3 — **landed as `0017_fed_observability.sql`**)

## API additions
`POST /federation/notify` (T2.1, **shipped**) · `GET /federation/tombstones` (T1.3, **shipped**) · `GET /federation/account-moves` (T3.2, **shipped**) · `account-move` feed type
(T3.2) · extended `/.well-known` (`publicKeys[]`, `protocolVersions`, richer `capabilities`) (T2.2/T4.1)
· `GET /federation/peers` returns trust+reputation + `POST /federation/peers/trust` operator promote/block
(T1.1, **shipped**). Corroboration query/response shape changes to grid+bucket (T1.2, **shipped** — coarse distance + bucketed ts + instance, no exact IGate; optional
`x-fed-secret` allowlist). Public read API gains origin+trust-tagged mirrored caches (T3.1). `POST /federation/submit`
(signed-envelope intake for push-to-hub, T2.3 **shipped**) + a relay/rendezvous WS endpoint (T2.3 path 2, deferred).

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
- **F5 (reach):** T2.1 gossip ping **(done)** · T2.2 generalized envelope/capability negotiation **(done)** · T2.3 NAT/firewall **(push-to-hub done; rendezvous relay deferred)**
  join (tunnel today → push-to-hub interim → rendezvous relay).
- **F6 (commons) — COMPLETE:** T3.1 federated catalog in API+map **(done)** · T3.2 account-move record **(done)** · T3.3 redaction **(done)**.
- **F7 (governance) — COMPLETE:** T4.1 key rotation **(done)** · T4.2 instance registry **(done)** · T4.3 observability **(done)**.

## Acceptance (abbreviated, per tier)
- **T1.1:** an unvetted/auto-discovered peer's caches are mirrored but hidden from the default map and
  excluded from verification until promoted; a blocked peer is never fetched.
- **T1.2:** a find upgrades to Tier A only when ≥ quorum distinct trusted instances corroborate; the
  corroboration endpoint rate-limits abuse and answers in coarse buckets, never exact coords/IGate
  (**met**: smoke asserts a bucketed distance, hidden IGate, no callsign on the wire, and a 429 under load).
- **T1.3:** deleting an account on instance A removes its mirrored copies on peer B after sync — the
  tombstone is signed, verifies against A's key, and carries no callsign/PII (**met**: smoke asserts the
  TOMB1 cache drops off B's map and the find tombstone is signed + PII-free).
- **T2.1:** a new find on A is mirrored/corroborated on B within seconds of a notify, not a poll cycle
  (**met**: smoke pings the subscriber and asserts the new cache mirrors without a manual sync, and that
  a rapid repeat notify is coalesced).
- **T2.2:** every feed serves + syncs through one generic envelope; a newer consumer syncing an older
  peer skips feeds it doesn't serve (404-as-skip) instead of failing the whole pull (**met**: negotiation
  unit-tested; smoke asserts `protocolVersions`/`capabilities` are advertised and an unknown feed 404s).
- **T2.3:** a peer with no inbound reachability contributes its caches/finds to a reachable hub via a
  tunnel (today) or push-to-hub (**met**: smoke asserts a spoke's signed cache is verified + mirrored onto
  the hub map, secret-gated, tampered records rejected, no cross-instance impersonation). Quorum
  corroboration from a tunnel-free spoke awaits the rendezvous relay (path 2, deferred). A pushed packet
  is no more trusted than a pulled one — same `remote_*` mirror, same display-only semantics.
- **T3.1:** the public map/API shows trusted-peer caches with origin attribution; unvetted are opt-in
  (**met**: smoke asserts originTrust tagging, an unvetted peer's caches hidden by default + revealed by
  `includeUnvetted=1`, and demote/re-promote flips visibility live).
- **T3.2:** moving OE8APR from A to B publishes a signed move the network mirrors, so peers learn the
  new home (**met**: smoke imports a callsign to the publisher, asserts the signed account-move record
  homes it there, the signature verifies, and the subscriber mirrors it + advances its moves_cursor).
  Live re-homing of mirrored find attribution is the documented follow-up.
- **T3.3:** a `local-only` cache never appears in any peer's mirror; `hint` never crosses the wire
  (**met**: smoke asserts a public cache federates with description but no hint, unlisted drops the
  description, local-only is absent from the feed, and no hint text appears anywhere in it).
- **T4.1:** rotating the instance key keeps records verifiable and new records trusted; a revoked key is
  rejected (**met**: smoke runs the whole mirror suite against a publisher with a 3-key set incl. a revoked
  one; `activeFedKeys`/`verifyRotationRecord` unit-tested; `rotatekey.mjs` output verifies end-to-end).
- **T4.2:** a peer can't impersonate a registered instance id — a signed registry binds instance→key and
  the consumer rejects a mismatch (**met**: the whole mirror suite runs under a registry binding the
  publisher's real key; `verifyRegistry`/`registryKeyAllowed` unit-test the verify + the impostor reject).
- **T4.3:** an operator can see each peer's health — sync success/error counts, lag, mirrored total, the
  per-feed breakdown, and the last error (**met**: smoke asserts the metrics populate after sync; the
  Workbench → Federation group renders them with a health badge).
