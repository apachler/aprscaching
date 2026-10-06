# Hubs, relays and the registry

This page shows the sysop how an instance that nobody can dial stays in the network, and how instances find
each other through a registry. At the end a firewalled instance, such as a phone or a box behind a carrier's
NAT, pushes its records to a hub you run. How push, catch-up and the relay work step by step is in
[Federation transports](transports.md).

## Before you start

- Both instances have a signing key and know each other's URL ([Join the network](index.md)).
- The hub answers on a public URL. The spoke needs only outbound connections.

## Reaching firewalled peers

A peer that can't be dialled inbound still takes a full part: it pushes its records to a hub, and through a
relay on the hub it answers feed queries and confirms finds logged elsewhere with its own receivers
([How a find gets confirmed across instances](how-it-works.md#how-a-find-gets-confirmed-across-instances)). A
direct address answers faster: a Cloudflare Tunnel or a 44Net address gives a firewalled instance one
([Choose how to connect](choose.md)).

### Push to a hub

The spoke sends its signed records to the hub's `POST /federation/submit`. The hub verifies each record, and the
submitter must be its own signer.

On the hub, in its `.env`:

```bash
FED_SUBMIT_SECRET=<a long random secret>       # turns submissions on
FED_SUBMIT_INSTANCES=oe8apr-pocket,oe8xyz.net  # the spokes allowed to push
```

On the spoke:

```bash
FED_HUB_URL=https://aprs.example.net           # the hub it pushes to
FED_SUBMIT_SECRET=<the hub's FED_SUBMIT_SECRET>
FED_PEERS=https://aprs.example.net             # optional: also pull from the hub
```

Restart both. What happens then:

- **The first push registers the spoke `unvetted`.** Its records arrive hidden on the hub's map until the hub's
  sysop promotes it under **Instance admin → Federation**. The secret decides who may introduce a new key to the
  hub; it does not say who the spoke is, so trusting it stays your call.
- **The hub refuses** a submission for an instance it knows under another key, and one for a blocked instance.
  A submission body is capped at 4 MiB.
- **A spoke that rotated its key** sends its rotation records with each push (`FED_ROTATIONS`), so the hub
  follows the rotation from the key it pinned.
- **Pushes resume.** The spoke keeps how far it pushed each feed in its database. It advances only when the hub
  accepts a page, so a restart never sends its history again. The hub returns where each spoke's feeds stand; a
  spoke reads that when it starts and after an outage, so a backup restored on either side resumes from what
  the hub holds.
- **Every feed, soon after each write.** The spoke pushes all its records the pull serves: caches, finds, keys,
  bulletins, account moves and deletions. A write goes out 3 seconds after it, a burst of writes in one cycle,
  and the scheduled cycle and **Sync now** push too.
- **Back-off after an outage.** After a network failure a Self-host, Desktop or Pocket spoke probes the hub's
  `/health?live` after 30 s, doubling up to 10 minutes, and pushes the moment it answers. While more pages wait
  than one cycle sends, the next cycle follows a few seconds later.

### A hub passes its spokes' records on

A hub serves what it mirrored again, so its spokes see each other's caches and finds, and so does every instance
that pulls the hub. A spoke needs no extra setting: one that pulls the hub (`FED_PEERS`) asks for them with the
rest.

Which records the hub passes on is the instance setting **Pass on peers' records** (`FED_RESERVE`), under
**Instance admin → Instance settings → Federation**:

- `trusted`, the default: the records of the instances trusted on the hub. Each spoke's records travel on once you
  trust that spoke.
- `all`: the records of every instance the hub has not blocked, unvetted spokes included.
- `off`: none. The hub keeps its spokes' records for its own map.

A change applies at each receiver's next pull: a home the hub trusts later, or a wider setting, sends its earlier
records too.

What an instance that pulls the hub does with them:

- **It asks per home instance.** It reads the hub's summary of what it holds of each home, and asks only for the
  records past what it already holds of that home, from any path
  ([How records travel through the mesh](how-it-works.md#how-records-travel-through-the-mesh)).
- **It checks every record against its home instance's key.** The hub signs none of them. It hands on the key it
  holds for each home in its summary, and the receiving instance pins that key the first time it sees it, in a
  peer row `transit:<instance>`: `unvetted` and never pulled. **Instance admin → Federation** lists it; compare
  its fingerprint with the home's sysop before you trust it, as for any peer. A registry binding wins over any
  hub's word, and once you follow the home directly its own key replaces the one the hub handed on.
- **It applies its own trust in the home, never the hub's.** A home you have not vetted stays hidden until a
  player includes unvetted peers; a home you block stays blocked on every path.
- **Deletions travel the same way**, a sysop's removal and restore of a cache included, and arrive before the
  records they remove.
- **A record travels a bounded way.** It crosses at most four instances, never goes back to its home, and two hubs
  that follow each other apply it once: a copy that comes round again changes nothing.
- **Trust the hub to save traffic.** What a hub you trust passes on counts as held, so another path never brings
  it again. What an unvetted hub passes on applies all the same, and your instance remembers how far it read that
  hub, but takes no hub's word it did not vet for what it holds, so a hub nobody vetted cannot keep a record from
  you by skipping it.

### Rendezvous relay

The relay is a mailbox on the hub: a requester leaves a query for a firewalled spoke, the spoke collects it on its
own outbound connection and answers it, and the requester collects the answer. A query asks for a page of the
spoke's signed caches, finds or keys, or asks the spoke's receivers to confirm a find. The relay is transport
only: a page is verified like a pulled one, and a confirmation like a direct answer
([Rendezvous relay](transports.md#rendezvous-relay)).

On the hub, in its `.env`:

```bash
FED_RELAY_SECRET=<a long random secret>        # turns the relay on; requesters send it
```

On the spoke, beside its push settings:

```bash
FED_HUB_URL=https://aprs.example.net           # the hub that holds its queries
FED_RELAY_SECRET=<any value>                   # turns collecting on; the spoke never sends it
```

Restart both. What happens then:

- **The spoke collects its queries** every 15 seconds (`FED_RELAY_POLL_MS`; `0` leaves it to the scheduled
  cycle, every 5 minutes) and answers each from its own database. It signs each request with its federation
  key, and the hub checks that key against the one it holds for the spoke: from a push, a pull or the registry.
  No spoke can collect or answer for another.
- **Finds are confirmed through the hub.** A find logged on the hub, or on an instance the hub knows (a peer it
  pulls from or a spoke that pushes to it), that trusts the spoke asks it through the relay; the spoke must push
  to the hub. The answer lifts the find within about 15 seconds while the spoke is online
  ([How a find gets confirmed across instances](how-it-works.md#how-a-find-gets-confirmed-across-instances)).
- **A requester** is a script or tool holding the hub's `FED_RELAY_SECRET`, or an instance asking a spoke to
  confirm a find, which signs its question and its read with its own key. A requester reads only its own
  results, by the ticket it got, and may hold 50 queries at once.
- **An unanswered query** returns to the queue 5 minutes after the spoke collected it.

A spoke with no internet path at all can take its queries as packet mail instead:
[Federation over FBB](fbb.md), experimental and off by default.

## The instance registry

A registry is a signed document that binds instance names to keys and operators. An instance refuses to mirror
a peer whose current key differs from the key its registry entry binds, so nobody can pose as a registered
instance.

1. **The registry authority signs the entries** from the repository root:

    ```bash
    node tools/fedkey/signregistry.mjs '[{"instance":"oe.net","url":"https://oe.aprscaching.net","key":"<public key>","operator":"OE8APR","aprsCall":"OE8APR-12"}]'
    ```

    It prints `FED_REGISTRY`, the signed document, and `FED_REGISTRY_KEY`, the authority's public key. Pass the
    authority key in `AUTHORITY` to sign again with the same one. An entry may carry `addresses`, the
    instance's typed endpoints (`https`, `44net`, `hamnet`, `ax25`, `netrom`, `bbs`): a directory of where to reach it, never a
    trust upgrade.

2. **Each member pins the authority key** in `FED_REGISTRY_KEY`, and gets the document one of two ways:
    - `FED_REGISTRY`: the document itself.
    - `FED_REGISTRY_DNS`: the name of a DNS `TXT` record holding `url=https://…`. DNS only says where the
      document lives; a `key=` in the record is ignored, so whoever controls DNS never chooses the signing key.
3. **Restart.** A registry setting without `FED_REGISTRY_KEY` is a configuration error: the gateway refuses
   to start.

How the registry behaves:

- Registered peers join your peer list `unvetted`.
- A DNS-located registry is cached for 5 minutes. A document older than the newest one accepted is refused as
  a replay.
- When the registry can't be fetched, the last good document keeps binding the instances it registered, so an
  outage never reopens them to impersonation.
- `GET /federation/registry` shows your instance's verified view, including its own entry: operator, APRS
  service call, and an optional amateur-network endpoint used for reachability only.

## Check that it worked

- On the spoke, **Instance admin → Federation** shows the last push, the records waiting and since when the hub
  is unreachable, with **Sync now**. On Pocket, `sync.sh --status` shows the same.
- On the hub, the same page lists each spoke's last submission. A spoke shows as stale after
  `FED_SPOKE_STALE_HOURS` (24) without one.
- On a spoke that pulls the hub, the other spokes' caches show *mirrored from* their home instance once you
  include unvetted peers or trust their homes, and **Instance admin → Federation** lists each home as a
  `transit:` peer.

## Next

- [Before a trip: sync and your home hub](../pocket/trips.md): a phone as the spoke.
- [Instance admin at a glance](../day-to-day/index.md): the other operator-only surfaces.
