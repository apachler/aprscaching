# Federation validation — September 2026

A validation of the federation layer against `dev` as of 28 September 2026. The wire and crypto layer
holds up: canonical CBOR, domain-prefixed Ed25519 signatures over the verbatim payload bytes, and one
verify pipeline shared by every carrier. The findings sit in two places — **identity binding**
(instance ids, key pins, the submit path, revocation, the registry) and **corroboration**, the only
exchange that can mint Tier A across instances — plus a set of privacy, data-correctness and
robustness items.

Every fix lands with a regression test that fails without it. This page tracks each finding's status;
the design it arrives at is documented in the [federation guide](../guides/federation.md) and the
[wire reference](../reference/federation-wire.md).

## Identity binding

| Finding | Where | Status |
|---|---|---|
| Instance ids are self-claimed: a peer's descriptor could rename its row, two rows could hold one id, an id containing `:` could claim part of another namespace, and tombstones were not scoped to their origin | `federation_sync.ts` `syncPeer`, `originKeys`, `isTombstoned`; `caches.ts` map join | Fixed — ids are lowercase hostnames, bound to one live row (unique index), never renamed; tombstones apply only to their origin |
| The key pin could move to any key listed in the descriptor, and extra listed keys verified frames | `federation_sync.ts` `syncPeer`; `federation.ts` `registryKeyAllowed` | Fixed — the pin moves only along verified rotations; other keys count only as proven predecessors; the registry key must be the current key |
| A submit-secret holder could submit as an instance known under another key, a blocked spoke was still applied, and new spokes were trusted | `federation_sync.ts` `submitRecords` | Fixed — the key must match every known row for the instance; blocked instances are refused; new spokes start `unvetted`; bodies capped at 4 MiB |
| Revocation was self-published, the rotation tool left the old key valid forever, and store-and-forward carriers ignored key history | `federation.ts` `activeFedKeys`; `tools/fedkey/rotatekey.mjs`; `originKeys` | Fixed — rotated-away keys expire after their `until` (default grace 7 days), the cutoff is sticky, and one stored accept set serves every carrier |
| The DNS-located registry took its authority key from DNS, had no rollback protection, and failed open to trust-on-first-use | `federation.ts` `loadRegistry`, `registryFromDns` | Fixed — the authority key is pinned in `FED_REGISTRY_KEY`; older documents are refused; the last good document keeps binding on failure; cached five minutes |
| A frame with an empty `signer` passed the self-attestation check | `federation_sync.ts` `acceptUnsigned` | Fixed — `signer` must equal the origin |

## Corroboration

| Finding | Where | Status |
|---|---|---|
| Corroboration answers are plain unsigned JSON, unbound to the question, and the default quorum is 1 | `corroborate.ts` | Fixed — signed question and answer frames (types 10 and 11) bound to a nonce and the question hash; unsigned answers ignored; default quorum 2 |
| The network-wide corroboration secret is sent to every peer, including unvetted and plain-http ones | `corroborate.ts` | Fixed — questions are signed; the secret is an optional extra gate sent only to trusted https peers; `FED_CORROBORATION_REQUIRE_KNOWN` limits answers to known peers |
| The logger's own IGates are not forwarded as exclusions, so a peer can corroborate through them | `caches.ts`, `corroborate.ts` | Fixed — forwarded with every question and re-checked on any revealed IGate |
| Peer-supplied evidence can set the corroborating instance, the IGate (which triggers alerts) and unchecked distances and times | `corroborate.ts`, `caches.ts` | Fixed — evidence rebuilt from range-checked fields; instance from the verified peer; IGate only with the asker's own opt-in |
| The quorum counts self-reported instance names rather than distinct verified identities | `corroborate.ts` `selectCorroboration` | Fixed — counts registry operators, else signing keys |
| Peer-corroborated finds skip the local track-plausibility check, and living caches are queried at their static coordinates | `caches.ts`, `verify.ts` | Fixed — `plausiblePresence` checks the local track; living caches are asked about the station's last fix |

## Privacy and data correctness

| Finding | Where | Status |
|---|---|---|
| The finds feed federates finds on `local-only` and imported caches | `federation.ts` finds feed | Fixed — finds are served only with a native, federating cache |
| Pagination stalls when a page's worth of rows share one timestamp | `federation.ts`, `bbs.ts`, `federation_sync.ts` | Fixed — composite `(timestamp, id)` cursor for caches and bulletins, on pull and push |
| One malformed record stalls a peer's feed or drops the rest of an FBB bulletin | `federation_sync.ts`, `forward.ts` | Fixed — each frame is applied on its own, required fields are validated, the cursor always advances |
| Bulletin ids fail the namespace check, so mirrored bulletins never apply | `bbs.ts` | Fixed — gid `instance:bulletin:id` with the BID in the body; the older gid is still read |
| The corroboration answerer does not snap the queried centre, bound the radius from below, or bucket and cap the time window | `corroborate.ts` | Fixed — snapped centre, radius 150–1000 m, bucketed window capped at an hour, no older than seven days |

## Replay and robustness

| Finding | Where | Status |
|---|---|---|
| Record versions and signing times are not enforced; key records have no version guard; far-future timestamps freeze a mirror; relay queries are not deduplicated | `federation_sync.ts`, `fedcbor.ts` | Fixed — strictly increasing per-gid versions (a cache counts revisions), future-signed frames refused, far-future timestamps clamped, relay frames acted on once while fresh |
| A sync page can carry frames of another record type, which are applied through that page's applier | `federation_sync.ts` `syncFeed` | Fixed — a page applies only its own record type |
| The unauthenticated notify endpoint can force syncs, and its cooldown map grows without bound | `gossip.ts` | Fixed — unknown instances ignored, per-host and per-instance limits, coalesced pulls, bounded map |
| Peer discovery accepts any URL (private and loopback addresses included), follows untrusted peers, has no global cap, and enables discovered peers at once | `federation_sync.ts`, `fedtransport.ts`, `packages/shared` endpoint validator | Fixed — https-only from trusted peers, disabled until enabled, capped at 200; a resolving fetch guard on Node/Bun |
| FBB bulletin ids for federation batches can be pre-posted and squatted, and can exceed the 12-character limit | `forward.ts`, `packages/shared` `fedbbs.ts` | Fixed — a batch BID must match its content before it is stored; BIDs are 12 characters |
| Pull pages have no byte or frame-count cap | `federation_sync.ts`, `fedtransport.ts` | Fixed — 4 MiB and the requested frame count |
| Relay spokes can derive each other's tokens; enqueue is uncapped, leases never expire, and results are readable by any spoke | `relay.ts` | Fixed — spokes sign lease and answer with their federation key; per-requester caps; leases expire; results need the requester's ticket |

## Low severity and operator safety

| Finding | Where | Status |
|---|---|---|
| A captured signed ingest batch replays within its freshness window | `keys.ts` | Open |
| Erasing an account does not tombstone mirrored callsign-key bindings or account moves | `account.ts`, `federation_sync.ts` | Open |
| Account moves carry no signed device-key migration proof (nothing reads them yet) | `account.ts` | Open |
| The answerer's per-callsign rate limit is shared by all askers, and its negative cache ignores radius and exclusions | `corroborate.ts` | Fixed — limits and the negative memo are per asker and include radius and exclusions |
| Standalone JSON signatures (rotation, registry, ingest) carry no domain prefix | `federation.ts`, `packages/shared` `canon.ts`, `tools/fedkey` | Open |
| 44net auto-admission relies on the DoH resolver's DNSSEC flag without saying so | `docs/reference/federation-wire.md` | Open |
| No "running federation safely" guidance for operators | `docs/guides/federation.md` | Open |
