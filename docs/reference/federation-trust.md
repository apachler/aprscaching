# How federation stays honest

This page sets out the rules that keep federation trustworthy: how records are signed, how a peer is bound to
one identity, how mirrors stay fresh without being replayed, and how instances corroborate each other's finds.
It is for sysops and integrators; joining the network is under [Join the network](../run/federation/index.md).

## Signed feeds

An instance with a signing key (`FED_PRIVATE_KEY`) publishes read-only, Ed25519-signed records in one
envelope: caches, finds, callsign keys, bulletins, tombstones and account moves. A consumer reads a peer's
descriptor (`GET /.well-known/aprscaching`) and its public keys, and **verifies every record's signature**
before mirroring it into display-only tables.

### What a feed carries

- Only `source='native'` caches with a federating scope are published. Imported heritage data and
  `local-only` caches never leave the instance.
- Finds federate only with their cache: a find on a `local-only` or imported cache stays home too.
- A cache marked `unlisted` withholds its description on the wire.

### Key rotation

`tools/fedkey/rotatekey.mjs` publishes the new key, a rotation record signed by the old key, and the old key
with an `until`: the rotation time plus a grace, 7 days by default (`FED_ROTATION_GRACE_DAYS`). A consumer:

- pins the first key it sees for a peer and moves the pin only along verified rotation records, so a hijacked
  domain that publishes a new key is refused;
- accepts an older published key only as a proven predecessor of the current one (a key it already trusted,
  from which a signed rotation leads to the current key), and only until its `until`, never later than the
  rotation time plus the grace;
- treats a rotated-away key as revoked for good once that cutoff passes, on every carrier: HTTP sync, FBB
  bulletins, HF beacons and packet circuits alike. A later descriptor cannot revive it.

## One row per instance

A peer's instance id (its hostname, such as `oe.example.net`) is bound to the peer row that first proved it,
and only one live (not blocked) row may hold that id.

- A second URL claiming a bound instance is refused.
- A descriptor that renames its instance is refused.
- Instance ids are lowercase hostnames; an id with a `:` or other characters outside a hostname is refused.

An impostor therefore never inherits another instance's namespace or trust. Moving a peer to a new URL means
blocking or removing its old row first.

## The registry binds names to keys

A signed instance registry binds instance names to keys and operators. Its authority key is always pinned in
`FED_REGISTRY_KEY`; the document comes from `FED_REGISTRY`, or from the `url=https://…` in the DNS `TXT`
record that `FED_REGISTRY_DNS` names. A DNS-located registry is cached for five minutes.

- DNS only says where the document lives. A `key=` in the record is ignored, because whoever can change a DNS
  record must not choose the key that signs the registry.
- A registry setting without `FED_REGISTRY_KEY` is a configuration error: the Node and Bun servers refuse to
  start, and on Workers every registry lookup fails closed.
- An instance refuses to mirror a peer whose **current** key is not the key its registry entry binds.
- A document older than the newest one already accepted is refused as a replay. When the registry cannot be
  fetched, the last good document keeps binding the instances it registered, so an outage never reopens them
  to impersonation.

## Mirrors stay fresh, never replayed

- **Records only move forward.** Every mirrored record carries a per-record version, and an instance applies a
  record only when its version is higher than the last one it applied. A replayed older record, or a different
  record at the same version, changes nothing. A cache's version counts its revisions, so two edits in one
  second are still two versions.
- **Pages are bounded.** A frame signed in the future, or a timestamp version in the future, is refused. A
  pulled page is capped at 4 MiB and at the number of frames asked for, and must carry only its own record
  type.
- **Deletes come first.** A pull applies tombstones before records, so a delete suppresses a re-mirror.
- **A gossip ping only asks for a pull.** After a federated write an instance sends its peers
  `POST /federation/notify` ("come pull from me"), which triggers an incremental sync. The endpoint is
  unauthenticated, so it only ever asks for a pull the instance would make anyway: a notify naming an
  instance it does not follow is ignored, each host and each instance is rate-limited, and the pull goes
  through the same coalescer as the scheduled sync.
- **Discovery is cautious.** With `FED_DISCOVER`, an instance learns peers only from trusted peers, takes only
  `https` URLs, adds each learned peer `unvetted` and disabled, and stops at 200 discovered peers.
- **Private networks stay closed.** On Node and Bun every federation fetch resolves its host first and refuses
  loopback, private, link-local and CGNAT addresses (IPv4 inside IPv6 included), and checks every redirect hop
  the same way. A URL from another party can never reach the host's LAN. The peers configured by hand
  (`FED_PEERS`, `FED_HUB_URL`) are exempt, and `FED_ALLOW_PRIVATE=1` opens it for a federation that lives on a
  LAN. Cloudflare Workers never reach a private network.

## Cross-instance corroboration

When a find cannot reach Tier A locally, the instance asks its **trusted** peers whether they independently
heard the callsign on RF near the cache, at a receiving site the logger does not control. The logger's own
calls and stations travel with the question as exclusions.

- **Quorum.** Distinct identities must agree before the find is promoted to Tier A: two by default
  (`FED_CORROBORATION_QUORUM`). They are counted by registry operator where the registry names one, else by
  signing key, so one operator running several instances is one voice.
- **Same rule as local Tier A.** A peer answers only from positions it attests itself: heard directly by one
  of its own receiving sites (its `FIRST_PARTY_SITES`) and delivered by that site's own ingest box. An APRS-IS
  copy naming such a site (`qAR,<site>`) never vouches, because anyone with a public passcode can inject one.
  An instance that attests no site never vouches for anyone.
- **Signed frames.** The question carries a fresh nonce, and the answer is bound to that nonce and to the
  question's hash. No middlebox, a plain-http 44Net peer included, can forge an answer or replay it against
  another question. Asking requires a signing key.
- **The logger's own track.** A local fix that puts the logger somewhere the answer's location cannot be
  reached from at a plausible speed keeps the find below Tier A. A living cache is asked about where its
  station last was.
- **No location oracle.** The answerer snaps and bounds every question (radius 150–1000 m, a bucketed window
  of at most an hour, no older than seven days) and coarsens every answer. The exact IGate is revealed only if
  both peers opt in (`FED_REVEAL_IGATE`).
- **Who is answered.** The shared `FED_CORROBORATION_SECRET`, if set, is sent only to trusted `https` peers,
  and an answerer that sets it answers only the peers holding it. `FED_CORROBORATION_REQUIRE_KNOWN=1` answers
  only peers whose key is known, `unvetted` ones included.
- **Reputation.** Peers carry a reputation (`rep_confirmed` / `rep_failed`). A peer that denies a
  corroboration the quorum confirmed accrues a contradiction and is penalised. With `FED_AUTO_PROMOTE`, an
  unvetted peer becomes trusted after that many confirmed corroborations.

### Asked again, within bounds

A find that misses Tier A only because trusted peers could not be reached (a timeout, a failed connection, a
rate limit or a server error, never a refusal) is asked again: the identical question, to those peers only,
one, six and 24 hours after the find, and never past 72 hours.

- Evidence already in hand carries over, but counts only while its peer is still trusted.
- The quorum, the exclusions and the logger's own-track check are the same as when the find was logged.
- A verified "no" from a trusted peer ends it at once; no later attempt follows one.
- A find lifted this way shows *confirmed later* and keeps the time (`corroborated_later_at`). Peers that
  mirrored the find keep the tier they first saw, since the finds feed carries each log once.

## Next

- [Federation wire format](federation-wire.md): the frames on the wire.
- [The trust model](trust-model.md): the tiers these rules protect.
