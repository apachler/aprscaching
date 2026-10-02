# Hubs, relays and the registry

How an instance behind a firewall stays in the network, and how instances find each other.

## Reaching firewalled peers

A peer that can't be dialled inbound can still contribute:

- **Push-to-hub.** A spoke pushes its signed records to a reachable hub's `POST /federation/submit`
  (secret-gated by `FED_SUBMIT_SECRET`; the hub verifies each record and requires the submitter to be its
  own signer). The signature proves which instance sent a record; the secret decides who may introduce a
  new spoke's key to the hub at all. A submission for an instance the hub already knows under another key, or for a blocked
  instance, is refused; a new spoke is registered `unvetted` until the operator promotes it. A spoke that
  rotated its key sends its rotation records with each push (`FED_ROTATIONS`), so the hub follows the
  rotation from the key it pinned. A submission body is capped at 4 MiB. Set `FED_HUB_URL` on the spoke.
  The spoke keeps how far it has pushed each feed in its database and advances it only when the hub
  accepts a page, so a restart resumes instead of sending its history again. The hub records where each
  spoke's feeds stand and returns it; a spoke reads it when it starts and after an outage, so a backup
  restored on either side resumes from what the hub holds. After a network failure a Node or Bun spoke
  probes the hub's `/health?live` (30 s, backing off to 10 minutes) and pushes the moment it answers; while
  more pages wait than one cycle sends, the next cycle follows a few seconds later. **Instance admin →
  Federation** shows the last push, the records waiting and since when the hub is unreachable, with **Sync
  now**; on a hub it lists each spoke's last submission, stale after `FED_SPOKE_STALE_HOURS`.
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

## Next

- [Instance admin at a glance](../day-to-day/index.md).
