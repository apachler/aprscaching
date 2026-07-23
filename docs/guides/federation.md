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
record's signature** before mirroring it into display-only tables. Keys can be rotated: an instance publishes
its key history and signed rotation records, and consumers accept a record under any active key.

Feed scoping is deliberate — only `source='native'` caches with a federating scope are published (imported
heritage data and `local-only` caches never leave the instance), and a cache marked `unlisted` withholds its
description on the wire.

## Peers and trust

Peers are rows with a **trust tier**:

| Trust | Behaviour |
|-------|-----------|
| `trusted` | Mirrored, and counted toward Tier-A corroboration. Peers you list in `FED_PEERS` start here. |
| `unvetted` | Mirrored but hidden on the map by default; probed only advisorily to earn trust. Registry- and transitively-discovered peers start here. |
| `blocked` | Never mirrored, never surfaced. |

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
  own signer). Set `FED_HUB_URL` on the spoke.
- **Rendezvous relay.** A poll-based relay lets a firewalled peer's feed be served through a hub with no
  tunnel and no inbound port (`/federation/relay/*`, gated by `FED_RELAY_SECRET`).

## The instance registry

A signed instance registry binds instance names to keys and operators, resolved from `FED_REGISTRY` (with
`FED_REGISTRY_KEY`) or a DNS-TXT anchor (`FED_REGISTRY_DNS`). An instance refuses to mirror a peer whose
published key doesn't match its registry binding — an anti-spoof check. Each instance exposes its verified
view at `GET /federation/registry`, including its own entry (operator, APRS service call, and an optional
reachability-only amateur-network endpoint).

## Cross-instance corroboration

The network effect: when a find can't reach Tier A locally, the instance asks its **trusted** peers whether
they independently heard the callsign on RF near the cache, gated by an IGate that isn't theirs. A
configurable **quorum** of distinct instances must agree before the find is promoted to Tier A. Queries and
responses are grid-snapped, time-bucketed, and distance-bucketed so corroboration is never a location oracle,
and the exact IGate is revealed only if both peers opt in (`FED_REVEAL_IGATE`).

## Privacy across the network

GDPR deletions propagate as **signed, PII-free tombstones** that name only a global record id (never a
callsign); consumers purge the mirrored rows and suppress re-mirroring. Account portability works the same
way — a signed account-move record re-points attribution when a user migrates instances.

## Joining the network

1. Generate a key and set `FED_PRIVATE_KEY` and `INSTANCE` (see [Deployment](../operate/deployment.md#sign-your-feeds)).
2. Add peers: `FED_PEERS=https://a.example,https://b.example`.
3. Optionally publish your operator identity (`FED_OPERATOR`, `FED_APRS_CALL`) and register in the shared
   instance registry.

Your instance now mirrors its peers, verifies everything it mirrors, and contributes corroboration back.
