# Federation

This page is for the [sysop](../glossary.md#sysop) who connects an instance to others. As a player you
need none of it: caches from the instances yours trusts appear on your map, and your finds travel to them.
In plain words, federation lets independent instances share caches, finds and keys as signed records, so
none of them has to trust the network in between.

Any instance — Cloudflare-edge or self-hosted — can join one open network. Federation is built on
**signed feeds and verified mirrors**, never on trusting a transport. Because a record's authenticity is
in its signature and not its path, the same signed records travel over any transport — HTTPS, plain HTTP
on a 44net/HAMNET amateur-IP name, and the packet-radio carriers — and on amateur RF a signature
authenticates but never conceals (see [Amateur-radio compliance](../operate/rf-regulatory.md)). The
byte-level format, typed peer endpoints (https / 44net / ax25 / netrom / bbs), and the ARDC-verified
44net onboarding flow are specified in the [Federation wire format](../reference/federation-wire.md); running
an instance on a 44Net address is covered in [Run an instance on 44Net](../operate/44net.md).

## Joining the network

1. **Sign your feeds.** `deploy/setup.sh` generates `FED_PRIVATE_KEY` (elsewhere:
   `node tools/fedkey/genkey.mjs`, see [Deployment](../operate/deployment.md#sign-your-feeds)). The key signs
   your feeds and your corroboration questions; the instance id follows `APP_URL`'s host.
2. **Add the peers you know** to `FED_PEERS` (`FED_PEERS=https://a.example,https://b.example`) and restart.
   They start `trusted`: your instance mirrors them and counts their corroboration. This is the primary
   path. **Instance admin → Federation** lists your peers and changes their trust, and admits a 44net peer by
   callsign; it does not add a peer by URL.
3. **Ask each peer's operator to do the same on their side** — add your `APP_URL` to their `FED_PEERS`.
   Until they do, their instance holds you `unvetted` if it learns of you at all (through discovery, the
   registry, 44net or a hub push): your records are mirrored but hidden on their map, and your answers do
   not count toward their Tier A. They promote you under **Instance admin → Federation**.
4. Optionally publish your operator identity (`FED_OPERATOR`, `FED_APRS_CALL`) and register in the shared
   instance registry.

Your instance then mirrors its peers, verifies everything it mirrors, and contributes corroboration back.
The settings that decide how much a stranger can do are collected in
[Federation operations](../reference/federation-operations.md).

## Identity on 44Net: `<call>.ampr.org`

For an instance run by a ham, `<call>.ampr.org` is the recommended identity binding. ARDC delegates that
name only after reviewing the holder's amateur licence, so a record the holder publishes under it ties a
federation key to a verified callsign. [Run an instance on 44Net](../operate/44net.md) is the step-by-step
recipe: the address, the DNS records, reachability and the self-check.

**Publishing.** The instance advertises its identity in one TXT record:

```
_aprscaching.<call>.ampr.org  TXT  "v=acs1; inst=<INSTANCE>; key=<federation public key>"
```

An optional `host=<name>` field names the host peers contact, when it is not `<call>.ampr.org` itself. It
must be `<call>.ampr.org` or a name under it; any other value invalidates the whole record. The same TXT
name may also carry a `v=acs1; verify=<code>` record for [callsign verification](../operate/administration.md#callsign-verification);
the two kinds sit side by side.

**Adding a peer by callsign.** **Instance admin → Federation** (or `POST /federation/peers/44net`, sysop
or operator secret) takes a base callsign and:

1. resolves the TXT record through `DOH_URL`;
2. fetches the peer's descriptor over plain http from the named host, when it is reachable. A descriptor
   whose instance id differs from `inst=`, or whose active keys don't include `key=`, is refused. An
   unreachable descriptor is not fatal: the DNS key alone becomes the pin;
3. admits the peer automatically when the resolver validated the answer with DNSSEC (the AD flag).
   Without DNSSEC it shows the resolved binding and the operator confirms it once — a trust-on-first-use
   pin. `ampr.org` is not DNSSEC-signed ([checked 2026-09-30](../operate/44net.md#3-name-and-identity)), so
   until ARDC signs the zone every admission is an operator confirmation.

**Key pinning and rotation.** The DNS key becomes the peer's key pin. From then on every sync verifies
against exactly that key, or a key the pin reaches through signed rotation records — the same rule as for
every peer ([Signed feeds](#signed-feeds)). A hijacked DNS record or host cannot move the pin on its own. A
peer that rotates its key updates its TXT record, so peers that add it later pin the new key.

**Plain http, signed content.** A 44net peer is contacted at `http://<host>`: amateur IP space has no
public certificate authority, and nothing it carries needs to be secret. Its records are signed, and
corroboration questions and answers are signed and bound to each other, so a middlebox on the link can
neither forge nor replay them ([Cross-instance corroboration](#cross-instance-corroboration)).
`FED_CORROBORATION_SECRET` is sent only to https peers, so over a 44net link the signatures carry the whole
weight.

**Identity, not trust.** The peer is stored with `verified_via = 'ardc-lot'` and enters **`unvetted`**:
mirrored, hidden on the map, and not counted toward Tier A until you promote it. `ardc-lot` records that
ARDC reviewed the licence behind the name — it never changes a trust tier, and neither does the 44.x address
the peer answers from. Re-adding a known peer never changes its tier, so a `blocked` peer stays blocked. A
peer's instance id binds to one live row: if you already follow the instance at its https URL, adding it by
callsign is refused as a binding conflict until you block or remove one of the two.

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
- accepts an older published key only as a proven predecessor of the current one — a key it already
  trusted (the old pin), from which a signed rotation leads to the current key — and only until its
  `until`, never later than the rotation time plus the grace;
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

To move a peer to a new URL, block or remove its old row first.

Peers carry a reputation (`rep_confirmed` / `rep_failed`). Set `FED_AUTO_PROMOTE` to auto-promote an unvetted
peer to trusted after that many confirmed corroborations. A peer that denies a corroboration the quorum
confirmed accrues a contradiction and is penalised.

## Keeping mirrors fresh

- **Pull sync** runs on a schedule and after a manual `POST /federation/sync`, negotiating which feeds a peer
  supports and applying tombstones first so a delete suppresses a re-mirror. A manual pull can be narrowed to
  some feeds and a page cap (`{"types":["cache","key"],"maxPages":10}`); deletes always come too, and the next
  pass carries on where a capped one stopped.
- **One region only.** `FED_SYNC_REGION=S,W,N,E` pulls only the caches inside that box from peers that filter
  by region, for an instance that serves one area (a phone in the field). Deletes are never filtered.
- **Gossip ping.** After a federated write an instance sends peers a `POST /federation/notify` "come pull
  from me," which triggers an incremental sync — freshness without a firehose. The endpoint is
  unauthenticated, so it only ever asks for a pull the instance would make anyway: a notify naming an
  instance it doesn't follow is ignored, a host and an instance are each rate-limited, and the pull goes
  through the same coalescer as the scheduled sync.
- **Records only move forward.** Every mirrored record carries a per-record version, and an instance applies
  a record only when its version is higher than the last one it applied — a replayed older record, or a
  different record at the same version, changes nothing. A cache's version counts its revisions, so two
  edits in one second are still two versions. A frame signed in the future, or a timestamp version in the
  future, is refused; a pulled page is capped at 4 MiB and at the number of frames asked for, and must carry
  only its own record type.
- **Discovery** (`FED_DISCOVER`) learns only from trusted peers, takes only `https` URLs, adds each learned
  peer `unvetted` and **disabled**, and stops at 200 discovered peers. Choosing a trust level for a
  discovered peer in the admin surface enables it.
- **Private networks.** On Node and Bun every federation fetch resolves its host first and refuses loopback,
  private, link-local and CGNAT addresses (IPv4 carried inside IPv6 included), and checks every redirect
  hop the same way, so a URL from another party can never reach this host's LAN. The
  peers you configured by hand (`FED_PEERS`, `FED_HUB_URL`) are exempt; set `FED_ALLOW_PRIVATE=1` for a
  federation that lives entirely on a LAN. Cloudflare Workers never reach a private network.

## Reaching firewalled peers

A peer that can't be dialled inbound can still contribute:

- **Push-to-hub.** A spoke pushes its signed records to a reachable hub's `POST /federation/submit`
  (secret-gated by `FED_SUBMIT_SECRET`; the hub verifies each record and requires the submitter to be its
  own signer). The signature proves which instance sent a record; the secret decides who may introduce a
  new spoke's key to the hub at all. A submission for an instance the hub already knows under another key, or for a blocked
  instance, is refused; a new spoke is registered `unvetted` until the operator promotes it. A spoke that
  rotated its key sends its rotation records with each push (`FED_ROTATIONS`), so the hub follows the
  rotation from the key it pinned. A submission body is capped at 4 MiB. Set `FED_HUB_URL` on the spoke.
- **Rendezvous relay.** A poll-based relay lets a firewalled peer's feed be served through a hub with no
  tunnel and no inbound port (`/federation/relay/*`, enabled by `FED_RELAY_SECRET`). The secret is what
  admits a requester — enqueueing and reading results carry no signature. A requester gets a
  ticket with each query and reads only its own results; queries per requester are capped. A spoke leases
  and answers by signing each request with its own federation key, which the hub checks against the key it
  holds for that instance — so the hub must already know the spoke (as a pulled peer, in the registry, or
  from a push-to-hub submission), and no spoke can act for another. An unanswered lease returns to the
  queue after five minutes.

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

## Privacy across the network

GDPR deletions propagate as **signed, PII-free tombstones** that name only a global record id (never a
callsign); consumers purge the mirrored rows and suppress re-mirroring. Tombstones are kept permanently on
both sides: they hold only ids, and a mirror checks them on every upsert so deleted data never comes back. Account portability works the same
way — a signed account-move record re-points attribution when a user migrates instances.
