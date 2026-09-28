# Federation

Any instance — Cloudflare-edge or self-hosted — can join one open network. Federation is built on
**signed feeds and verified mirrors**, never on trusting a transport. Because a record's authenticity is
in its signature and not its path, the same signed records travel over any transport — HTTPS, plain HTTP
on a 44net/HAMNET amateur-IP name, and the packet-radio carriers — and on amateur RF a signature
authenticates but never conceals (see [Amateur-radio compliance](../operate/rf-regulatory.md)). The
byte-level format, typed peer endpoints (https / 44net / ax25 / netrom / bbs), and the ARDC-verified
44net onboarding flow are specified in the [Federation wire format](../reference/federation-wire.md).

## Signed feeds

An instance with a signing key (`FED_PRIVATE_KEY`) publishes read-only, Ed25519-signed records over a
generalized envelope: caches, finds, callsign keys, bulletins, tombstones, and account-moves. A consumer
pulls a peer's descriptor (`GET /.well-known/aprscaching`), reads its public key(s), and **verifies every
record's signature** before mirroring it into display-only tables.

Keys can be rotated with `tools/fedkey/rotatekey.mjs`: the instance publishes its new key, a rotation record
signed by the old key, and the old key with an `until` (the rotation time plus a grace, 7 days by default;
set `FED_ROTATION_GRACE_DAYS` to change it). A consumer:

- pins the first key it sees for a peer and moves the pin only along verified rotation records, so a
  hijacked domain that simply publishes a new key is refused;
- accepts an older published key only as a proven predecessor of the current one, and only until its
  `until` (or the rotation time plus the grace when it names none);
- treats a rotated-away key as revoked for good once that cutoff passes — a later descriptor cannot
  revive it — on every carrier: HTTP sync, FBB bulletins, HF beacons and packet circuits alike.

Feed scoping is deliberate — only `source='native'` caches with a federating scope are published (imported
heritage data and `local-only` caches never leave the instance), finds federate only with their cache (a find
on a `local-only` or imported cache stays home too), and a cache marked `unlisted` withholds its description
on the wire.

## Peers and trust

Peers are rows with a **trust tier**:

| Trust | Behaviour |
|-------|-----------|
| `trusted` | Mirrored, and counted toward Tier-A corroboration. Peers you list in `FED_PEERS` start here. |
| `unvetted` | Mirrored but hidden on the map by default; probed only advisorily to earn trust. Registry- and transitively-discovered peers start here. |
| `blocked` | Never mirrored, never surfaced. |

Push-to-hub spokes start `unvetted` too: the submit secret authorises a spoke to push, it does not say
who the spoke is, so trusting it is the operator's call.

### One row per instance

A peer's instance id (its hostname, such as `oe.example.net`) is bound to the peer row that first proved
it, and a live (non-blocked) row is the only one allowed to hold that id. A second URL claiming a bound
instance is refused, and a descriptor that renames its instance is refused, so an impostor never inherits
another instance's namespace or trust. Instance ids are lowercase hostnames; an id with a `:` or other
characters outside a hostname is refused.

If an upgrade stops with *several non-blocked fed_peers rows claim one instance id*, the database already
holds such a conflict. List the rows with

```sql
SELECT url, instance, trust, added_via, public_key FROM fed_peers
 WHERE instance IN (SELECT instance FROM fed_peers WHERE instance IS NOT NULL AND trust != 'blocked'
                    GROUP BY instance HAVING COUNT(*) > 1)
 ORDER BY instance, url;
```

then keep the genuine peer (usually the one whose key you verified out of band) and set every other row to
`blocked` (`POST /federation/peers/trust`, or `UPDATE fed_peers SET trust='blocked' WHERE url=…`) or delete it,
and migrate again. The upgrade never picks a winner on its own, since the older row could be the impostor.
To move a peer to a new URL, block or remove its old row first.

Peers carry a reputation (`rep_confirmed` / `rep_failed`). Set `FED_AUTO_PROMOTE` to auto-promote an unvetted
peer to trusted after that many confirmed corroborations. A peer that denies a corroboration the quorum
confirmed accrues a contradiction and is penalised.

## Keeping mirrors fresh

- **Pull sync** runs on a schedule and after a manual `POST /federation/sync`, negotiating which feeds a peer
  supports and applying tombstones first so a delete suppresses a re-mirror.
- **Gossip ping.** After a federated write an instance sends peers a `POST /federation/notify` "come pull
  from me," which triggers an incremental sync — freshness without a firehose.

## Reaching firewalled peers

A peer that can't be dialled inbound can still contribute:

- **Push-to-hub.** A spoke pushes its signed records to a reachable hub's `POST /federation/submit`
  (secret-gated by `FED_SUBMIT_SECRET`; the hub verifies each record and requires the submitter to be its
  own signer). A submission for an instance the hub already knows under another key, or for a blocked
  instance, is refused; a new spoke is registered `unvetted` until the operator promotes it. A submission
  body is capped at 4 MiB. Set `FED_HUB_URL` on the spoke.
- **Rendezvous relay.** A poll-based relay lets a firewalled peer's feed be served through a hub with no
  tunnel and no inbound port (`/federation/relay/*`, gated by `FED_RELAY_SECRET`).

## The instance registry

A signed instance registry binds instance names to keys and operators. Its authority key is always pinned in
`FED_REGISTRY_KEY`; the document comes from `FED_REGISTRY` or is located through a DNS `TXT` record named
by `FED_REGISTRY_DNS` (`url=https://…`). DNS only says where the document lives: a `key=` in the record is
ignored, because whoever can change a DNS record must not choose the key that signs the registry. A
registry setting without `FED_REGISTRY_KEY` is a configuration error — the Node and Bun servers refuse to
start, and on Workers every registry lookup fails closed.

An instance refuses to mirror a peer whose **current** key isn't the key its registry entry binds — an
anti-spoof check. A DNS-located registry is cached for five minutes; a document older than the newest one
already accepted is refused as a replay, and when the registry can't be fetched the last good document keeps
binding the instances it registered, so an outage never reopens them to impersonation. Each instance exposes
its verified view at `GET /federation/registry`, including its own entry (operator, APRS service call, and an
optional reachability-only amateur-network endpoint).

## Cross-instance corroboration

The network effect: when a find can't reach Tier A locally, the instance asks its **trusted** peers whether
they independently heard the callsign on RF near the cache, through an IGate the logger doesn't control —
the logger's own calls and stations travel with the question as exclusions. A **quorum** of distinct
identities must agree before the find is promoted to Tier A: two by default (`FED_CORROBORATION_QUORUM`),
counted by registry operator where the registry names one, else by signing key, so one operator running
several instances is one voice. A peer answers only from positions heard through a receiving site it attests
itself (its own `FIRST_PARTY_SITES`), the same rule as its local Tier A; an instance that attests no site
never vouches for anyone.

Questions and answers are signed frames: the question carries a fresh nonce, and the answer is bound to that
nonce and to the question's hash, so an answer can be neither forged by a middlebox — a plain-http 44net
peer included — nor replayed against another question. Asking requires a signing key. A peer-corroborated
find is also checked against the logger's own local track: a local fix that puts the logger somewhere the
answer's location can't be reached from at a plausible speed keeps the find below Tier A. A living cache is
asked about where its station last was. The answerer snaps and bounds every question (radius 150–1000 m, a
bucketed window of at most an hour, no older than seven days) and coarsens every answer, so corroboration is
never a location oracle; the exact IGate is revealed only if both peers opt in (`FED_REVEAL_IGATE`). The
shared `FED_CORROBORATION_SECRET`, if set, is sent only to trusted https peers; set
`FED_CORROBORATION_REQUIRE_KNOWN=1` to answer only peers you know.

## Privacy across the network

GDPR deletions propagate as **signed, PII-free tombstones** that name only a global record id (never a
callsign); consumers purge the mirrored rows and suppress re-mirroring. Account portability works the same
way — a signed account-move record re-points attribution when a user migrates instances.

## Joining the network

1. Generate a key and set `FED_PRIVATE_KEY` and `INSTANCE` (see [Deployment](../operate/deployment.md#sign-your-feeds)). The
   key signs your feeds and your corroboration questions.
2. Add peers: `FED_PEERS=https://a.example,https://b.example`.
3. Optionally publish your operator identity (`FED_OPERATOR`, `FED_APRS_CALL`) and register in the shared
   instance registry.

Your instance now mirrors its peers, verifies everything it mirrors, and contributes corroboration back.
