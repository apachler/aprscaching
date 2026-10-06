# Federation transports

This page lists every way federation records travel between instances, for the sysop who sets them up and the
integrator who wants the facts. For each one it says what it carries, who starts it, how it works step by
step, when it runs, what you configure, its limits and how far it is tested. Which one suits your instance is in
[Choose how to connect](choose.md); the bytes on the wire are in
[Federation wire format](../../reference/federation-wire.md).

## Every transport at a glance

The records are the same signed frames on every transport. The receiving instance checks each signature
against the key it pinned for the record's origin, so no transport adds or removes trust
([How federation stays honest](../../reference/federation-trust.md)).

| Transport | Carries | Who starts it | Delay | Default | Tested |
|---|---|---|---|---|---|
| [Pull](#pull) over https, 44Net or HAMNET | caches, finds, keys, bulletins, tombstones, account moves; the caches, finds and tombstones a hub passes on | the instance that wants the records | seconds after a write, at most `FED_SYNC_INTERVAL_MS` (5 min) | on for every peer you add | CI, two instances on one host |
| [Push to a hub](#push-to-a-hub) | caches, finds, keys, tombstones | the spoke | at most `FED_SYNC_INTERVAL_MS`; 30 s to 10 min after an outage | off | CI, two instances on one host |
| [Rendezvous relay](#rendezvous-relay) | a firewalled spoke's caches, finds or keys feed, on request | a requester with the hub's relay secret | at most `FED_SYNC_INTERVAL_MS` for the spoke to answer | off | CI, two instances on one host |
| [Corroboration exchange](#corroboration-exchange) | one question and its answer about a find | the instance where the find is logged | seconds; retried 1, 6 and 24 h later | on with a signing key | CI, two instances on one host |
| [Presence beacon](#presence-beacon) | an instance's addresses, one datagram | the operator's own tooling | whenever it transmits | endpoints only | unit tests |
| [Packet circuit](#packet-circuit) (AX.25, NET/ROM) | feed pages over a connected-mode session | the pulling station | one page of 25 records at a time | not wired in | unit tests |
| [FBB store-and-forward](#fbb-store-and-forward) | a batch of feed records as packet mail | the sysop, by hand or timer | hours to days | off (`FED_BBS`) | local loop over AX.25; not on real BBS networks |

None of the transports has run between independent instances on live infrastructure: the public internet,
44Net, HAMNET or a BBS network. The CI federation test runs two real gateways side by side on one machine.

## Pull

**What it carries.** Every feed: caches, finds, callsign keys, bulletins, tombstones and account moves.
Tombstones come first, so a deletion arrives before the record it deletes. Last comes the transit feed: the
caches, finds and tombstones the peer mirrored from other instances and passes on, each still signed by its home
([A hub passes its spokes' records on](hubs-and-relays.md#a-hub-passes-its-spokes-records-on)).

**How it works.** Your instance asks each peer, "what is new since my last cursor?" The peer answers with a
page of up to 500 records it signed itself. Your instance checks each signature, applies what is newer than what
it holds, and keeps the cursor for next time. When the peer writes something new, it sends your instance a short
"come and pull" ping (`POST /federation/notify`), and your instance pulls at once. The ping is unsigned and only
asks for a pull your instance would make anyway: a ping from an instance you do not follow is ignored.

```mermaid
sequenceDiagram
  participant A as Your instance
  participant B as Peer
  Note over B: a player hides a cache
  B->>A: notify, come and pull
  A->>B: GET new records since my cursor
  B-->>A: page of records, each signed by B
  Note over A: check every signature against B's pinned key
  Note over A: apply tombstones first, then newer records
```

**When.** Every `FED_SYNC_INTERVAL_MS` (default 300000, 5 minutes; `0` turns the schedule off), for every
enabled peer. A notify brings records within seconds when the peer can reach your URL. **Sync now** under
**Instance admin → Federation** pulls from every peer at once; **Sync now** on a peer's row pulls from that one,
three times a minute at most.

**Configure.** A signing key on the peer; the peer added under **Instance admin → Federation** or in
`FED_PEERS` ([Join the network](index.md)). Optional: `FED_SYNC_REGION` to pull one area's caches only.

**Limits.** A page is at most 4 MiB and 500 records; a pass reads at most 50 pages per feed and carries on at
the next. Each address gets 5 seconds to answer, a `hamnet` address 2.

### Addresses: https, 44Net and HAMNET

A pull, a notify and a corroboration question go to the same addresses. A peer publishes its own in
`FED_ENDPOINTS`; your instance learns them from its descriptor on every sync, from its callsign's DNS record, or
from its beacon. It tries them in priority order (lower first), keeps the first that answers for the rest of the
sync, and tries the URL it added the peer under last.

| `transport` | `address` | Reached over | Notes |
|---|---|---|---|
| `https` | `https://aprs.example.net` | https on the internet | the usual address |
| `44net` | `aprscaching.oe8apr.ampr.org` or `https://aprscaching.oe8apr.ampr.org` | plain http on the name; with `https://`, https first and then plain http | a name under `<call>.ampr.org`, never a raw 44.x address |
| `hamnet` | `44.143.1.2`, `aprscaching.oe8xyz.hamnet.example`, optional `:port` | plain http | a peer without a route to HAMNET gives up after 2 seconds |
| `ax25`, `netrom`, `bbs` | `OE8APR-10`, `ACSNOD`, `OE8APR@OE8XBB.#KTN.AUT.EU` | nothing dials them | a directory entry for packet operators, published with the rest |

```bash
FED_ENDPOINTS='[{"transport":"https","address":"https://aprs.example.net","priority":10},{"transport":"44net","address":"https://aprscaching.oe8apr.ampr.org","priority":20},{"transport":"hamnet","address":"44.143.1.2","priority":30}]'
```

A peer added by callsign reads the addresses from the `_aprscaching` TXT record under `<call>.ampr.org`
(`host=` for 44Net, `web=` for https), and those stay whatever its descriptor says
([44Net name and identity](../networks/44net-identity.md#3-name-and-identity)). Plain http on 44Net and HAMNET
changes no trust: every record is signed, and a corroboration answer is bound to its question. The addresses an
instance serves to browsers are set in `EXTRA_ORIGINS`
([One instance, several addresses](../networks/several-addresses.md)).

**Tested.** Pull and notify run in CI between two gateways; the region filter has server tests. Address order and the fall back
from https to http are covered by the gateway's tests. Real 44Net and HAMNET routing is untested.

## Push to a hub

**What it carries.** The spoke's own tombstones, caches, finds and callsign keys, in that order. Bulletins and
account moves stay with pull.

**How it works.** The spoke sends pages of its signed records to the hub's `POST /federation/submit`, with the
hub's submit secret. The secret decides who may introduce a new key to the hub; the hub checks every record's
signature, and the records must all be signed by the spoke itself. The first push registers the spoke as an
**unvetted** peer on the hub. The hub answers each page with how far it now holds that feed, and the spoke saves
that mark, so a restart or a restored backup resumes where the hub stands.

```mermaid
sequenceDiagram
  participant S as Spoke, no inbound port
  participant H as Hub
  S->>H: GET my marks, how far do you hold me
  H-->>S: last cursor per feed
  loop each feed, tombstones first
    S->>H: POST page of records signed by S, submit secret
    Note over H: check the secret, then every signature
    H-->>S: new mark for that feed
  end
  Note over H: spoke shows unvetted until the sysop trusts it
```

**When.** In the same scheduled cycle as pull, every `FED_SYNC_INTERVAL_MS`. A write on the spoke does not push
at once. **Sync now** pushes immediately.

**Configure.** On the hub: `FED_SUBMIT_SECRET`, and `FED_SUBMIT_INSTANCES` to name the spokes allowed. On the
spoke: `INSTANCE`, `FED_PRIVATE_KEY`, `FED_HUB_URL` and the hub's `FED_SUBMIT_SECRET`; add the hub to `FED_PEERS`
to pull from it too ([Push to a hub](hubs-and-relays.md#push-to-a-hub)).

**Limits.** A submission is at most 4 MiB, 500 records a page and 50 pages per feed per cycle. Once the hub's
sysop trusts the spoke, the hub passes its records on to the other spokes and to every instance that pulls the
hub, as the spoke signed them (`FED_RESERVE`).

### Catch-up after an outage

A phone or a box on a flaky line loses its hub often. Catch-up makes it resume promptly instead of waiting for the
next scheduled cycle.

```mermaid
sequenceDiagram
  participant S as Spoke
  participant H as Hub
  S-xH: push fails, no network
  loop 30 s, 60 s, 120 s ... up to 10 min
    S-xH: GET /health?live
  end
  S->>H: GET /health?live
  H-->>S: answers
  S->>H: read my marks again, then push
  Note over S: more than one cycle waiting: next cycle after 5 s
```

After a push fails for a network reason, the spoke probes the hub's `/health?live` after 30 seconds, doubling
the wait up to 10 minutes. The first answer starts a full cycle at once, which reads the hub's marks again.
While more pages wait than one cycle sends, the next cycle follows 5 seconds later. **Instance admin →
Federation** shows the last push, the records waiting and since when the hub is unreachable; the hub shows a spoke
as stale after `FED_SPOKE_STALE_HOURS` (24) without a push.

**Tested.** Push, marks, resume and catch-up run in CI between two gateways and in the server tests.

## Rendezvous relay

**What it carries.** One feed page of a firewalled spoke, on request: its caches, finds or callsign keys since a
cursor, at most 1000 records, signed by the spoke.

**How it works.** The relay is a mailbox on the hub, so a question can reach a spoke that nobody can dial. A
requester leaves a query for the spoke at the hub and gets a ticket. The spoke collects the queries addressed to
it on its own outbound connection, answers each from its own database, and posts the answer back. The requester
collects the answer with its ticket. The spoke signs each collect and answer request with its federation key,
and the hub checks that key against the one it already holds for the spoke, so no spoke can answer for another.
The answer is a page of the spoke's signed records: whoever uses it checks every signature, as for a pull.

```mermaid
sequenceDiagram
  participant R as Requester
  participant H as Hub
  participant S as Spoke, no inbound port
  R->>H: POST query for S, relay secret
  H-->>R: ticket
  S->>H: GET my queries, request signed by S
  H-->>S: queries addressed to S
  Note over S: build a page of its own signed records
  S->>H: POST answer, request signed by S
  R->>H: GET result, relay secret and ticket
  H-->>R: signed page
  Note over R: check every signature against S's key
```

**When.** The spoke collects queries in its scheduled cycle, every `FED_SYNC_INTERVAL_MS`, so an answer is ready
within one interval. A query the spoke collected but did not answer goes back to the queue after 5 minutes; an
unanswered query older than an hour goes at the nightly cleanup.

**Who asks.** No instance asks through the relay on its own. The requester is a script or a tool that holds
the hub's `FED_RELAY_SECRET`; it may hold up to 50 queries waiting and make 60 a minute. To apply a relayed page
on an instance, post it to that instance's `POST /federation/frames` with its operator or ingest secret: the
frames go through the same checks as a pull. The relay does not carry
[corroboration questions](#corroboration-exchange): the query kind for them is reserved, and a spoke answers only
feed queries.

**Configure.** On the hub: `FED_RELAY_SECRET`. On the spoke: `FED_HUB_URL` and `FED_RELAY_SECRET` (any value turns
the spoke's collecting on; the spoke never sends it), a signing key, and a hub that already knows the spoke's key
through a push, a pull or the registry ([Rendezvous relay](hubs-and-relays.md#rendezvous-relay)).

**Limits.** An answer is at most 8 MiB. A spoke collects at most 25 queries per cycle.

**Tested.** Enqueue, collect, answer and result run in CI between two gateways.

## Corroboration exchange

**What it carries.** One signed question about a find ("did your own receivers hear this call, here, then?")
and one signed answer. Nothing of it is mirrored or forwarded.

**How it works.** [How a find gets confirmed across instances](how-it-works.md#how-a-find-gets-confirmed-across-instances)
explains it in full, with its diagram. As a transport: the asking instance posts the question to the peer's
`POST /federation/corroborate` at the peer's pull addresses, up to three of them, in the same order as a pull.

**When.** When a find is logged and has not reached Tier A on its own; every trusted peer at once, 3 seconds
each. Peers that could not be reached are asked again 1, 6 and 24 hours after the find, never after 72 hours.

**Configure.** `FED_PRIVATE_KEY` to ask; trusted peers to ask; your own receiving sites (`FIRST_PARTY_SITES` or
**Instance admin → Trusted receiving stations**) to answer "yes". Optional: `FED_CORROBORATION_QUORUM`,
`FED_CORROBORATION_SECRET`, `FED_CORROBORATION_REQUIRE_KNOWN`, `FED_REVEAL_IGATE`.

**Limits.** A peer is asked only at an address the asking instance can dial: never through a hub, the relay or
packet radio. A spoke that only pushes is never asked.

**Tested.** Tier A by peer corroboration, the quorum and the retries run in CI between two gateways.

## Presence beacon

**What it carries.** One signed record: the instance's id and its `FED_ENDPOINTS` addresses, in one AX.25 UI
datagram of at most 251 bytes. The lowest-priority addresses drop out until it fits, and a trimmed beacon says so.

**How it works.** The gateway serves its current beacon at `GET /federation/beacon`, ready to transmit. A heard
beacon goes to the receiving gateway's `POST /federation/beacon` (ingest or operator secret). A beacon from a
peer you already know, signed by its pinned key, updates that peer's addresses. A beacon never adds a peer, and
one from an unknown instance is quarantined.

```mermaid
sequenceDiagram
  participant G1 as Gateway A
  participant T1 as A's radio tooling
  participant T2 as B's radio tooling
  participant G2 as Gateway B
  T1->>G1: GET /federation/beacon
  G1-->>T1: signed datagram payload
  T1->>T2: UI frame on the air
  T2->>G2: POST /federation/beacon, ingest secret
  Note over G2: known peer and pinned key: update its addresses
```

**When.** Whenever the operator's tooling transmits it. The gateway schedules nothing.

**Configure.** `FED_ENDPOINTS` and a signing key. The ingest box does not transmit or decode beacon datagrams:
transmitting is the operator's own tooling, under the rules for
[automatic stations on the air](../compliance/on-air-stations.md).

**Tested.** The gateway's encode, trim and receive paths have unit tests. Not on the air.

## Packet circuit

**What it carries.** Feed pages, over an AX.25 or NET/ROM connected-mode session, in the record set the link
supports: at 1200 or 9600 baud no media and small batches (25 records on a VHF port), on HF only tiny records.

**How it works.** A line protocol (`ACSL1`) rides the same session machinery as the BBS and the node. Both ends
exchange their link capabilities and agree on the slower rate, the smaller batch and the best common
compression. The pulling station then asks for one feed page at a time. Its ingest box hands each page to its own
gateway's `POST /federation/frames`, where every frame is checked against its origin's key. The ingest box
holds no keys.

```mermaid
sequenceDiagram
  participant G1 as Gateway A
  participant I1 as A's ingest box
  participant I2 as B's ingest box
  participant G2 as Gateway B
  I1->>I2: connect, capabilities
  I2-->>I1: capabilities
  I1->>I2: request a page, feed and cursor
  I2->>G2: GET /federation/sync page
  G2-->>I2: page signed by B
  I2-->>I1: page, compressed
  I1->>G1: POST /federation/frames
  Note over G1: check every frame against B's key
```

**When.** When the pulling station connects, one page at a time (25 records on a VHF port).

**Configure.** Nothing in settings: the two protocol ends are a library (`@aprscaching/packet`
`FedSyncApp` and `FedSyncLinkClient`, with the ingest side in `apps/ingest/src/fedsynclink.ts`), and no ingest
setting mounts them. Dialing the circuit uses the same driver stack as FBB forwarding.

**Tested.** The protocol ends and the compression have unit tests. Not over a real circuit.

## FBB store-and-forward

**Experimental**, off by default and untested on real BBS networks.

**What it carries.** A batch of the instance's own records (tombstones first, then caches, finds, keys, account
moves and bulletins), at most 900 per batch, as one personal message to `ACSFED` at a partner BBS.

**How it works.** The sysop asks the gateway to pack the records changed since a cursor into one signed batch.
The batch waits in the BBS outbox and goes to the partners marked for federation at the next forwarding session.
The partner's instance takes a batch only from a partner it marked, checks every frame against the keys it holds
for the origin, and applies the newer records. A batch from an instance it does not know stays quarantined.

```mermaid
sequenceDiagram
  participant SA as Sysop A
  participant A as Instance A
  participant B as Partner instance B
  SA->>A: POST /federation/bbs/enqueue, since cursor
  Note over A: pack signed records into one ACSFED message
  A->>B: FBB forwarding session, personal mail to ACSFED
  Note over B: marked partner only, check every frame
  Note over B: apply newer records, quarantine unknown origins
```

**When.** The sysop queues a batch by hand or from a timer; the forwarding schedule carries it. Hours to days.
A batch already forwarded cannot be recalled.

**Configure.** `FED_BBS=1` on both instances, FBB forwarding with the partner, the partner marked
**Federation (experimental)**, and the partner sysop's agreement ([Federation over FBB](fbb.md)). The same
carrier takes the relay's queries to a packet-only spoke
(`POST /federation/relay/<instance>/dispatch`), and the spoke answers over FBB.

**Tested.** The interop local loop carries a signed batch between two instances over real AX.25/AXUDP. Not on a
real BBS network.

## Next

- [Choose how to connect](choose.md): which transport suits your instance.
- [Federation wire format](../../reference/federation-wire.md): frames, pages and batches byte by byte.
