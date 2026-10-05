# Hubs, relays and the registry

This page shows the sysop how an instance that nobody can dial stays in the network, and how instances find
each other through a registry. At the end a firewalled instance, such as a phone or a box behind a carrier's
NAT, pushes its records to a hub you run. How push, catch-up and the relay work step by step is in
[Federation transports](transports.md).

## Before you start

- Both instances have a signing key and know each other's URL ([Join the network](index.md)).
- The hub answers on a public URL. The spoke needs only outbound connections.

## Reaching firewalled peers

A peer that can't be dialled inbound still contributes in two ways: it pushes its records to a hub, or it
answers feed queries through a relay on the hub. Neither lets peers ask it to confirm a find: a corroboration
question needs an address the asking instance can dial
([How a find gets confirmed across instances](how-it-works.md#how-a-find-gets-confirmed-across-instances)). A
Cloudflare Tunnel or a 44Net address gives a firewalled instance one ([Choose how to connect](choose.md)).

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
- **Back-off after an outage.** After a network failure a Self-host, Desktop or Pocket spoke probes the hub's
  `/health?live` after 30 s, doubling up to 10 minutes, and pushes the moment it answers. While more pages wait
  than one cycle sends, the next cycle follows a few seconds later.

### Rendezvous relay

The relay is a mailbox on the hub: a requester leaves a query for a firewalled spoke, the spoke collects it on its
own outbound connection and answers with a page of its signed caches, finds or keys, and the requester collects
the answer. The relay is transport only: the answer is verified like a pulled page
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

- **The spoke collects its queries** in every scheduled cycle (`FED_SYNC_INTERVAL_MS`, 5 minutes) and answers each
  from its own database. It signs each request with its federation key, and the hub checks that key against the
  one it holds for the spoke: from a push, a pull or the registry. No spoke can collect or answer for another.
- **A requester** is a script or tool holding the hub's `FED_RELAY_SECRET`. No instance asks through the relay on
  its own. A requester reads only its own results, by the ticket it got, and may hold 50 queries at once.
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

## Next

- [Before a trip: sync and your home hub](../pocket/trips.md): a phone as the spoke.
- [Instance admin at a glance](../day-to-day/index.md): the other operator-only surfaces.
