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
| `type` (1) | 1 cache · 2 find · 3 key · 4 bulletin · 5 tombstone · 6 account-move · 7 peer descriptor |
| `gid` (2) | The content address, `origin:kind:localid` — apply is **idempotent by gid** |
| `origin` (3) | Originating instance id (namespace authority: a peer only serves its own prefix) |
| `v` (4) | Per-gid monotonic version — duplicated / re-ordered / multi-path delivery converges |
| `at` (5) | Signing time, unix seconds |
| `signer` (6) | Callsign or instance id |
| `body` (7) | Type-specific fields, text-keyed, integer-scaled numbers only |

A receiver verifies the signature **over the received payload bytes verbatim** (never a re-encode)
against the origin's published key set, then applies by `(type, gid, v)`. Cursors are per-transport
delivery hints, not the source of truth — the content address is.

## The sync surface

`GET /federation/sync/<type>?since=&limit=` (type ∈ `cache · find · key · tombstone · account-move ·
bulletin`) serves a CBOR page of frames:

```
page = CBOR { 1 instance, 2 nextCursor, 3 complete, 4 [frame bytes …] }   (application/cbor)
```

The page envelope is unsigned — each record carries its own signature. A signed instance advertises
the surface as the `sync-cbor` capability in its descriptor; a consumer that sees it pulls frames
and verifies each under the peer's active keys, then runs the **same** namespace/self-attestation/
tombstone acceptance checks and the same appliers as the JSON feeds, so the two encodings can never
diverge in mirror semantics. An unsigned instance (no frame signatures possible) does not serve the
surface, and consumers fall back to the JSON feeds. `/federation/peers` reports which encoding the
last sync used (`lastCounts.encoding`).

**Scaled fields.** The deterministic codec carries no floats, so fractional record fields travel as
integer twins and map back on receipt:

| JSON field | Wire field | Scale |
|---|---|---|
| `lat` / `lon` | `latE7` / `lonE7` | ×10⁷ (1e-7°, ~1 cm) |
| `difficulty` / `terrain` | `difficultyX10` / `terrainX10` | ×10 (half-steps exact) |
| `distanceM` | `distanceCm` | ×100 (centimetres) |

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

Sync transports (request/response) pick the lowest-priority endpoint that resolves to a URL; the
legacy peer `url` is the https fallback. Forward transports are fire-and-forget carriers whose
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

## 44net verified onboarding

ARDC's portal reviews an amateur licence before delegating `<call>.ampr.org` (its Level-of-Trust
process), so the name is an externally-verified callsign binding. A peer advertises its federation
identity in DNS:

```
_aprscaching.<call>.ampr.org  TXT  "v=acs1; inst=<instance-id>; key=<b64url raw Ed25519>"
```

`POST /federation/peers/44net { callsign }` (sysop-only) resolves that TXT over DNS-over-HTTPS
(`DOH_URL`, default Cloudflare) and cross-checks the peer's live descriptor when reachable:

- **DNSSEC-validated** (the resolver's AD flag) → the peer is admitted automatically.
- **No DNSSEC** → the response returns the resolved binding and the operator confirms once
  (trust-on-first-use); `confirm: true` pins it.
- A descriptor that **contradicts** the DNS binding is refused outright.

The DNS-advertised key becomes the peer's **key pin** — every sync verifies against exactly that key
or a signed rotation from it. Admission attests **identity only** (`verified_via = 'ardc-lot'`): the
peer enters `unvetted`, and the operator-set trust tier still decides whether its records count.

On amateur RF all of this stays legal because the wire format **signs and never encrypts** — every
frame is readable off the air; see [Amateur-radio compliance](../operate/rf-regulatory.md).
