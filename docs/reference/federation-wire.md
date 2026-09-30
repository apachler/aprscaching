# Federation wire format

Federation records travel as **deterministic CBOR signed under Ed25519**. A record's authenticity
lives entirely in its bytes — the same signed frame is valid over HTTPS on the public internet,
plain HTTP on a 44net/HAMNET amateur-IP name, an AX.25/NET-ROM circuit, or BBS store-and-forward.
The verify engine never consults the path a frame took: **transport is never trust** ([Core
concepts](../concepts.md)).

## The signed form

The canonical serialization is the RFC 8949 §4.2 core-deterministic CBOR subset: definite lengths
only, map keys sorted by their encoded bytes, shortest-form integers, and **no floats, tags, or
indefinite lengths**. A decoder accepts only exactly-canonical bytes, so every signed payload has
one — and only one — parse. Coordinates travel as integers in **1e-7-degree units** (`latE7`,
`lonE7`, ~1 cm resolution) because float encodings are not byte-deterministic across encoders.

```
payload = CBOR { 1 type, 2 gid, 3 origin, 4 v, 5 at, 6 signer, 7 body }
signed  = "acs-fed/1\n" || payload            ← the domain prefix rules out cross-protocol replay
frame   = CBOR { 1 payload (bytes), 2 signerKey (b64url raw Ed25519), 3 sig (bytes) }
```

| Envelope field | Meaning |
|---|---|
| `type` (1) | 1 cache · 2 find · 3 key · 4 bulletin · 5 tombstone · 6 account-move · 7 peer descriptor · 8 relay query · 9 relay answer · 10 corroboration question · 11 corroboration answer |
| `gid` (2) | The content address, `origin:kind:localid` — apply is **idempotent by gid**. A bulletin's gid is `origin:bulletin:localid`; its FBB BID travels in the body (`bid`) and is kept only in the origin's own `localid_origin` form, and a bulletin under that older gid is still accepted |
| `origin` (3) | Originating instance id — a lowercase hostname, never containing `:` (namespace authority: a peer only serves its own `origin:` prefix) |
| `v` (4) | Per-gid version, strictly increasing: a receiver applies a record only above the last version it applied for that gid. A cache's `v` is its revision counter plus 2³²; a bulletin's is its posting time; the rest count up |
| `at` (5) | Signing time, unix seconds; a frame signed more than 300 s in the future is refused |
| `signer` (6) | The signing instance id; a mirrored record is accepted only when it equals `origin` |
| `body` (7) | Type-specific fields, text-keyed, integer-scaled numbers only |

A receiver verifies the signature **over the received payload bytes verbatim** (never a re-encode)
against the origin's accept set (below), then applies by `(type, gid, v)`. Cursors are per-transport
delivery hints, not the source of truth — the content address is.

Standalone signed JSON documents outside the CBOR frames carry their own domain prefix, prepended to
the canonical (key-sorted) JSON: `acs-rot/1\n` for a rotation record `{key, prevKey, at}`,
`acs-reg/1\n` for a registry `{at, entries}`, and `acs-ing/1\n` for a signed ingest batch. Verifiers
accept only the prefixed bytes, so a signature made for one document type never verifies as another.

### Accept sets

The keys a peer's frames verify under are decided by the receiver, never by the peer's descriptor alone,
and stored on its peer row (`fed_peers.accept_keys`) so every carrier uses the same set:

- **The pin.** The first key seen for a peer, bound together with its instance id. The pin moves only to a
  key the old pin reaches through verified rotation records (`{key, prevKey, at}` signed by `prevKey`).
- **Proven predecessors.** Another published key counts only if the receiver already trusted it (the old
  pin, or a key still in the stored accept set) and a verified rotation chain leads from it to the current
  key — a rotation record is signed by its own `prevKey`, so only prior trust can vouch for one. It counts
  until its cutoff: its published `until`, else the rotation time plus the grace (`FED_ROTATION_GRACE_DAYS`,
  7 by default), and never past the rotation time plus the grace. On first contact no predecessor is
  admitted. A cutoff never moves later once recorded, so a later
  descriptor cannot revive a rotated-away key, and a rotated-away key never becomes the pin again.
- **The registry binding.** When the signed registry binds the instance to a key, the peer's current key
  must be that key; it is also accepted for frames from that origin.

A key merely listed in the descriptor's `publicKeys`, without a rotation chain, is never accepted. An
instance id is bound to one live peer row: a second URL claiming it, or a descriptor renaming it, is
refused.

## The sync surface

`GET /federation/sync/<type>?since=&limit=` (type ∈ `cache · find · key · tombstone · account-move ·
bulletin`) serves a CBOR page of frames:

```
page = CBOR { 1 instance, 2 nextCursor, 3 complete, 4 [frame bytes …], 5 nextId? }   (application/cbor)
```

The cache and bulletin feeds page by a timestamp, which many records can share, so their cursor is
composite: the page's `nextId` is the local id of its last record, and the consumer asks for the next
page with `?since=<nextCursor>&sinceId=<nextId>` to resume strictly after that pair. A consumer keeps the
tie-breaker only while a pass still has pages to read; once a page is complete it resumes from the
timestamp alone, re-reading that second (idempotent) so a record updated again within it is not missed.
Without `sinceId` a feed returns records at or after `since`; a consumer that doesn't know field 5
ignores it. Each frame on a page is applied on its own: a malformed or unappliable record is skipped
and counted, and the cursor still moves past it.

**Region filter.** `bbox=S,W,N,E` (decimal degrees; west greater than east crosses the antimeridian) narrows
the `cache` feed to the caches inside the box; a malformed box is a 400. Every other feed ignores it, so
deletes, keys and account moves always travel whole and a region never hides a delete. A publisher that
serves the filter lists `sync-cache-bbox` in its descriptor's capabilities; a consumer sends a box only to
such a publisher and pulls the whole feed elsewhere. A cursor is exact only for the box it was read under,
so a consumer whose box changes (or goes away) reads the caches feed again from the start. A cache edited to
move out of the box is not sent again; the consumer keeps its last copy until a delete or a whole-feed pull.

The page envelope is unsigned — each record carries its own signature. This is the **only wire
mirroring consumes**: a consumer pulls frames, verifies each under the peer's active keys, then runs
the namespace/self-attestation/tombstone acceptance checks and the appliers. A signed instance
advertises the surface as the `sync-cbor` capability in its descriptor. An unsigned instance (no
frame signatures possible) does not serve the surface and cannot be mirrored. The JSON feeds
(`/federation/feed/*`) are an unsigned transparency/browse surface only — nothing consumes them for
mirroring.

**Scaled fields.** The deterministic codec carries no floats, so fractional record fields travel as
integer twins and map back on receipt:

| JSON field | Wire field | Scale |
|---|---|---|
| `lat` / `lon` | `latE7` / `lonE7` | ×10⁷ (1e-7°, ~1 cm) |
| `difficulty` / `terrain` | `difficultyX10` / `terrainX10` | ×10 (half-steps exact) |
| `distanceM` | `distanceCm` | ×100 (centimetres) |

## Corroboration exchange

Cross-instance corroboration is a live request/response exchange, the only one that can lift a find
to Tier A, so both halves are signed fedwire frames and neither is ever mirrored or forwarded. The
asker `POST`s a `corroborationQuery` frame (type 10) to `/federation/corroborate` as
`application/cbor`; any other content type is answered 415. Its body carries `callsign`,
`latE7`/`lonE7`, `radiusM`, `since`, `until`, `excludeIgates` (the base calls the logger controls),
a fresh random `nonce`, and `target` (the answerer's instance id). The answerer replies with a
`corroboration` frame (type 11) whose body is `{nonce, queryHash, corroborated, distanceCm?, ts?,
igateCall?}`, where `queryHash` is the hex SHA-256 of the question's payload bytes.

- **The answerer** verifies the question under the asker's accept set when the asker is a known
  peer, and otherwise as an anonymous key (refused under `FED_CORROBORATION_REQUIRE_KNOWN=1`); a
  blocked asker is refused. `at` must be within ±120 s. It bounds the question — centre snapped to the
  grid, radius clamped to 150–1000 m, window bucketed and capped at one hour, and a window that ended
  more than seven days ago refused — and coarsens the answer to a distance bucket and a bucketed time.
  Rate limits apply per host, per asker, and per asker and callsign; a "no" is memoised per asker,
  question, radius and exclusion set.
- **The asker** counts an answer only if it verifies under the peer's accept set, names the peer as
  origin and signer, is within ±120 s, and echoes its nonce and question hash. Evidence is rebuilt from
  range-checked fields: the instance is the verified peer, the distance must lie within the asked
  radius and the time within the asked window, and an `igateCall` is kept only when the asker also sets
  `FED_REVEAL_IGATE` and it is not one of the logger's own calls. The quorum counts distinct identities:
  the registry operator when there is one, else the signing key.

An instance advertises the exchange as the `corroborate-signed/1` capability; asking requires a
signing key (`FED_PRIVATE_KEY`).

## Peer endpoints

A peer's identity is its instance id + published signing keys. Its **addresses are data**: an
ordered set of typed endpoints carried on the peer record (`fed_peers.endpoints`).

| Transport | Address form | Mode | Notes |
|---|---|---|---|
| `https` | full URL | sync | The default internet path |
| `44net` | `<call>.ampr.org` hostname | sync | Plain HTTP inside amateur IP space (no public CA); the *name* is the durable identity |
| `ax25` | `CALLSIGN-SSID` | forward | Packet circuit via the operator's ingest box |
| `netrom` | node alias | forward | NET/ROM-routed circuit |
| `bbs` | `CALL@BBS.#REGION.CC.CONT` | forward | Store-and-forward over FBB forwarding |

Sync transports (request/response) pick the lowest-priority endpoint that resolves to a URL; a peer
that stores no endpoint set is reached at its `url`, the https address it was added under. Forward transports are fire-and-forget carriers whose
limits are operator configuration — frames apply idempotently on arrival, whatever path they took.

An instance publishes its own endpoint set from `FED_ENDPOINTS` in two places: its
`/.well-known/aprscaching` descriptor (`addresses`) and, when a registry authority signs it, its
registry entry (`addresses`). The registry copy is authority-signed, so it is a tamper-proof
directory of who-is-reachable-where — still addressing only, never a trust uplift. Every address is
re-validated through the typed endpoint validator on load, so a malformed entry never rides in.

## Link capabilities

Sync links exchange capabilities on connect and intersect them; forward links are statically
configured. The effective profile picks the record tier:

| Tier | Links | Carries |
|---|---|---|
| `full` | 44net / HAMNET / internet | every record type, large batches |
| `compact` | VHF 1200/9600 Bd | no media payloads, small delta batches |
| `beacon` | HF 300 Bd, datagram | tiny records only (peer-announce, tombstone, have-lists) |

`negotiateCaps` resolves the slower rate class, smaller MTU/batch, best mutually-supported
compression, and smaller record set; operator policy may clamp further.

## Store-and-forward over FBB

A forward link has no live handshake, so a batch of frames rides an FBB bulletin exactly as it rides
an HTTP sync page — the same signed frames, a different carrier. `encodeFedBbsBatch` packs the frames
into a text-safe bulletin body addressed to the reserved category `ACSFED`:

```
ACSFED1 <frame-count> <BID>
<base64 of the CBOR frame array, wrapped at 64 columns>
```

The body is 7-bit clean and whitespace-tolerant, so classic FBB line limits and CR/LF handling never
corrupt it. The **BID is content-addressed** (a 64-bit FNV-1a over the payload): identical batches
carry the same BID, so a bulletin flooded across the mesh dedups by BID at every relay, and
`decodeFedBbsBatch` re-derives it to reject a truncated or forged body rather than half-apply it.

The receiver verifies every frame's signature against the claimed origin's registered keys and
applies each idempotently by global id — a bulletin cannot lift trust or reach outside its origin's
namespace, and an origin the instance does not already know stays quarantined, exactly as an
HTTP-sync peer does.

Both halves ride the existing BBS machinery:

- **Send** — `POST /federation/bbs/enqueue {types?, since?, limit?}` (sysop or the operator's ingest
  box) signs the local feed records (tombstones first) into fedwire frames — the same producer the
  HTTP sync surface uses — packs them into one `ACSFED` bulletin, and stores it as a local BBS
  bulletin. The forwarding rules, pool, and partner scheduler then carry it like any other bulletin;
  the content BID lands in `bbs_messages.bid` (UNIQUE), so an unchanged snapshot never double-posts.
- **Receive** — an inbound forwarded message addressed to `ACSFED` triggers the trust-gated apply on
  first sight (a re-flooded copy dedups on its BID before the apply). The claimed origin only selects
  which key set to verify against — the accept set last verified for that peer plus its signed-registry
  binding; an unknown or operator-blocked origin is quarantined, never applied.

`ACSFED` bulletins are machine carrier traffic: the human bulletin listing hides them unless the
category is asked for explicitly.

## Push paths

Push-to-hub submits the same wire: a spoke POSTs a CBOR sync page of its signed frames to
`/federation/submit` (`application/cbor` only — any other content type is answered 415; one
submission is one key — a second key smuggled into the batch is rejected; the body is capped at 4 MiB).
The submitted key must be one the hub already verified for that instance under any peer row (and the
registry's binding, when there is one); a blocked instance is refused, and a new spoke is registered
`unvetted`. A spoke whose key changed sends its rotation records as JSON in `x-fed-rotations`; the hub
moves the spoke's pin only along them, by the same rules as a pulled peer. Relay feed answers carry
a CBOR page (`pageB64`, a base64 fedwire page). Every mirrored record travels as a signed fedwire
frame; the stableStringify signing base exists only for standalone signed documents (the registry,
key-rotation records, account operations), never for feed records.

## Connected-mode sync (AX.25 / NET-ROM circuits)

Pull-sync over a packet circuit is a line protocol riding the same session machinery as the BBS and
the node, so it works through connect-through and stays legible on a monitor:

```
server greets:  ACSL1 H <b64(cbor caps)>       both ends intersect LinkCaps deterministically
client:         ACSL1 H <b64(cbor caps)>
client:         ACSL1 R <b64(cbor {type, since, limit})>
server:         ACSL1 P <b64(page bytes)>      one CBOR sync page per request
either:         ACSL1 E <text>
```

On links that negotiated `deflateDict1`, page payloads are dictionary-compressed before base64. The
server clamps the limit to the negotiated `batchMax` and halves it until the reply fits the session
line budget. Both ends are operator-local: the serving side sources pages from its own gateway's
CBOR sync surface (mount `FedSyncApp` as a node service), and the pulling side delivers each page to
its own gateway at `POST /federation/frames` (ingest-gated), where the shared trust-gated pipeline
verifies every frame against its origin's keys — the page envelope's claimed instance is ignored,
and the ingest holds no keys. Dialing the RF circuit itself rides the same driver stack as FBB
forwarding and is validate-at-deploy.

## Beacon tier

One signed fedwire frame in one unconnected AX.25 UI datagram (`ACSB1` magic + the frame verbatim,
bounded to a single-frame fit) — for links where even a BBS session is a luxury. `GET
/federation/beacon` serves this instance's presence datagram: a signed `peer` record carrying its
typed endpoint set, trimmed from the lowest priority up until it fits; the operator's ingest box
fetches and transmits it on its own schedule (TX stays operator-local and gated). A heard datagram
goes to `POST /federation/beacon` (ingest-gated) and into the same trust-gated pipeline as every
carrier — a verified peer-announce from a KNOWN origin refreshes that peer's self-attested endpoints
(an UPDATE only: hearing a beacon never inserts a peer), an unknown origin is quarantined, and tiny
records (tombstones) apply idempotently by gid. There is no batch envelope and no BID at this tier;
the global id is the dedup.

The rendezvous relay rides the same carrier for a packet-only spoke. `POST
/federation/relay/<instance>/dispatch` (sysop/ingest) packs the spoke's queued queries into signed
`relayQuery` frames and marks them leased; the spoke's receive path answers each from its own DB and
sends back a signed `relayAnswer` frame, which lands in the hub's relay queue for the requester —
scoped to rows addressed to the answering instance, so a spoke can only ever answer its own queue.
The frame signatures bind both directions to their instances, so no secret material ever rides the air.
Each relay frame is acted on once (by gid) and only within three days of its signing time. On the HTTP
legs, the spoke signs each lease and answer request with its federation key over
`"acs-relay/1\n" || METHOD " " path?query "\n" at "\n" hex(SHA-256(body))`, sent as `x-relay-instance`,
`x-relay-at` (±120 s) and `x-relay-sig`; the hub verifies it against the accept set it holds for that
instance. Relay cargo (query params, the
answered feed page) travels as JSON text inside the CBOR bodies — feed pages carry floats, which the
deterministic codec refuses by design.

## 44net verified onboarding

ARDC's portal reviews an amateur licence before delegating `<call>.ampr.org` (its Level-of-Trust
process), so the name is an externally-verified callsign binding. A peer advertises its federation
identity in DNS, under its callsign or under a host of its own in the callsign's zone:

```
_aprscaching.<call>.ampr.org  TXT  "v=acs1; inst=<instance-id>; key=<b64url raw Ed25519>[; host=<name>]"
_aprscaching.<host>           TXT  "v=acs1; inst=<instance-id>; key=<b64url raw Ed25519>"
```

| Field | Meaning |
|---|---|
| `inst` | The instance id, exactly as `INSTANCE` |
| `key` | The current federation public key: raw Ed25519, base64url (the descriptor's `publicKey`) |
| `host` | Optional. Where peers contact the instance: `<call>.ampr.org` itself or a name under it (`aprscaching.oe8apr.ampr.org`). Without it, peers contact the name whose record they read |

A record at `_aprscaching.<call>.ampr.org` is found by callsign; a record at `_aprscaching.<host>`, for a
`<host>` under `<call>.ampr.org`, is found by that host and needs no `host=`. Per-host records let one
callsign publish several instances — a home station and a Pocket — each under its own name. `host=` only
moves where the peer is reached. It is lowercased and must be a valid hostname (labels of 1–63 letters, digits and inner hyphens, at most
253 characters, no trailing dot) inside the callsign's own zone. A `host=` anywhere else — another domain,
another call's zone — rejects the whole record: a TXT in one callsign's zone never points federation traffic
at a third party. The same name may also carry a `v=acs1; verify=<code>` record for callsign verification;
that record is separate and does not carry the binding.

`POST /federation/peers/44net { callsign }` or `{ host }` (sysop-only) resolves the TXT at
`_aprscaching.<call>.ampr.org` or `_aprscaching.<host>` over DNS-over-HTTPS (`DOH_URL`, default
Cloudflare) and cross-checks the live descriptor at `http://<host>` when reachable. A host is lowercased,
loses one trailing dot, and must be `<call>.ampr.org` or a name under it for a valid base call; anything
else is refused before a lookup. More than one valid `acs1` binding at the name is ambiguous: the answer is
`409` with `candidates: [{ instance, host }]`, and the operator adds one by its host. The peer is stored
under `http://<host>` with a `44net` endpoint of that address:

- **DNSSEC-validated** (the resolver's AD flag) → the peer is admitted automatically. The gateway
  does not validate DNSSEC itself: it trusts the AD flag of the DoH resolver it asks, which makes that
  resolver (`DOH_URL`) a trusted party for automatic admission. Point `DOH_URL` only at a validating
  resolver you trust; the admitted peer still starts `unvetted`.
- **No DNSSEC** → the response returns the resolved binding and the operator confirms once
  (trust-on-first-use); `confirm: true` pins it.
- A descriptor that **contradicts** the DNS binding is refused outright.

The DNS-advertised key becomes the peer's **key pin** — every sync verifies against exactly that key
or a signed rotation from it. Admission attests **identity only** (`verified_via = 'ardc-lot'`): the
peer enters `unvetted`, and the operator-set trust tier still decides whether its records count. `host=`
and per-host records change none of this: the identity stays the callsign whose zone holds the record, and
the key pin and trust are the same either way. An instance id already held by another live peer is refused.

The peer row records that callsign as `operator_call`. The corroboration quorum counts a peer by its
registry operator, else this call, else its signing key, so every instance added under one callsign is one
voice.

`GET /api/admin/setup/44net` (sysop-only) runs the same lookups against this instance's own records —
the A record of the host peers contact, the TXT's `inst` and `key` against this instance (the endpoint's
own `_aprscaching.<host>` record first, then the callsign's), whether the callsign's record sends peers to
this host with another binding, and the 44net endpoint of the descriptor it serves — and reports each as pass, warn or fail with a fix
([Your first hour as sysop](../operate/first-hour.md#the-checklist)). It only reads DNS; it writes nothing.

On amateur RF all of this stays legal because the wire format **signs and never encrypts** — every
frame is readable off the air; see [Amateur-radio compliance](../operate/rf-regulatory.md).
