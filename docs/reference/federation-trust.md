# How federation stays honest

The mechanics behind federation: how records are signed, how a peer is bound to one row, and how instances
corroborate each other's finds.

## Signed feeds

An instance with a signing key (`FED_PRIVATE_KEY`) publishes read-only, Ed25519-signed records over a
generalized envelope: caches, finds, callsign keys, bulletins, tombstones, and account-moves. A consumer
pulls a peer's descriptor (`GET /.well-known/aprscaching`), reads its public key(s), and **verifies every
record's signature** before mirroring it into display-only tables.

Keys can be rotated with `tools/fedkey/rotatekey.mjs`: the instance publishes its new key, a rotation record
signed by the old key, and the old key with an `until` (the rotation time plus a grace, 7 days by default;
set `FED_ROTATION_GRACE_DAYS` to change it). A consumer:

- pins the first key it sees for a peer and moves the pin only along verified rotation records, so a
  hijacked domain that publishes a new key is refused;
- accepts an older published key only as a proven predecessor of the current one — a key it already
  trusted (the old pin), from which a signed rotation leads to the current key — and only until its
  `until`, never later than the rotation time plus the grace;
- treats a rotated-away key as revoked for good once that cutoff passes — a later descriptor cannot
  revive it — on every carrier: HTTP sync, FBB bulletins, HF beacons and packet circuits alike.

Feed scoping is deliberate — only `source='native'` caches with a federating scope are published (imported
heritage data and `local-only` caches never leave the instance), finds federate only with their cache (a find
on a `local-only` or imported cache stays home too), and a cache marked `unlisted` withholds its description
on the wire.

## Cross-instance corroboration

The network effect: when a find can't reach Tier A locally, the instance asks its **trusted** peers whether
they independently heard the callsign on RF near the cache, at a receiving site the logger doesn't control —
the logger's own calls and stations travel with the question as exclusions. A **quorum** of distinct
identities must agree before the find is promoted to Tier A: two by default (`FED_CORROBORATION_QUORUM`),
counted by registry operator where the registry names one, else by signing key, so one operator running
several instances is one voice. A peer answers only from positions it attests itself, the same rule as its
local Tier A: heard directly by one of its own receiving sites (its `FIRST_PARTY_SITES`) and delivered by that
site's own ingest box. An APRS-IS copy naming such a site (`qAR,<site>`) never vouches, because anyone with a
public passcode can inject one; an instance that attests no site never vouches for anyone.

Questions and answers are signed frames: the question carries a fresh nonce, and the answer is bound to that
nonce and to the question's hash, so an answer can be neither forged by a middlebox — a plain-http 44net
peer included — nor replayed against another question. Asking requires a signing key. A peer-corroborated
find is also checked against the logger's own local track: a local fix that puts the logger somewhere the
answer's location can't be reached from at a plausible speed keeps the find below Tier A. A living cache is
asked about where its station last was. The answerer snaps and bounds every question (radius 150–1000 m, a
bucketed window of at most an hour, no older than seven days) and coarsens every answer, so corroboration is
never a location oracle; the exact IGate is revealed only if both peers opt in (`FED_REVEAL_IGATE`). The
shared `FED_CORROBORATION_SECRET`, if set, is sent only to trusted https peers, and an answerer that sets it
answers only the peers holding it; set `FED_CORROBORATION_REQUIRE_KNOWN=1` to answer only peers whose key
you know (including `unvetted` ones).

**Asked again, within bounds.** A find that misses Tier A only because trusted peers could not be reached — a
timeout, a failed connection, a rate limit or a server error; never a refusal — is asked again: the identical
question, to those peers only, one, six and 24 hours after the find, and never past 72 hours. Evidence already
in hand carries over, but counts only while its peer is still trusted; the quorum, the exclusions and the
logger's own-track check are the same as when the find was logged. A verified "no" from a trusted peer ends it
at once, and no later attempt follows one. A find lifted this way shows *confirmed later* and keeps the time
(`corroborated_later_at`); peers that mirrored the find keep the tier they first saw, since the finds feed
carries each log once.

## Next

- [Federation wire format](federation-wire.md).
