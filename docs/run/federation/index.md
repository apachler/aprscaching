# Join the network

This page is for the [sysop](../../glossary.md#sysop) who connects an instance to others. As a player you
need none of it: caches from the instances yours trusts appear on your map, and your finds travel to them.
In plain words, federation lets independent instances share caches, finds and keys as signed records, so
none of them has to trust the network in between.

Any instance — Cloudflare-edge or self-hosted — can join one open network. Federation is built on
**signed feeds and verified mirrors**, never on trusting a transport. Because a record's authenticity is
in its signature and not its path, the same signed records travel over any transport — HTTPS, plain HTTP
on a 44net/HAMNET amateur-IP name, and the packet-radio carriers — and on amateur RF a signature
authenticates but never conceals (see [Automatic stations on the air](../compliance/on-air-stations.md)). The
byte-level format, typed peer endpoints (https / 44net / ax25 / netrom / bbs), and the ARDC-verified
44net onboarding flow are specified in the [Federation wire format](../../reference/federation-wire.md); running
an instance on a 44Net address is covered in [44Net address](../networks/44net.md).

## Joining the network

1. **Sign your feeds.** `deploy/setup.sh` generates `FED_PRIVATE_KEY` (elsewhere:
   `node tools/fedkey/genkey.mjs`, see [Sign your feeds](#sign-your-feeds)). The key signs
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
The settings that decide how much a stranger can do are collected under
[Running federation safely](#running-federation-safely).

## Sign your feeds

To take part in federation, generate an instance key and set it as a secret so your feeds are signed:

`deploy/setup.sh` generates the key for the Docker stack. Elsewhere:

```bash
node tools/fedkey/genkey.mjs        # prints FED_PRIVATE_KEY + the public key it publishes
# Cloudflare:  npx wrangler secret put FED_PRIVATE_KEY
# Node/Bun:    export FED_PRIVATE_KEY=...
```

The instance id (`INSTANCE`) follows `APP_URL`'s host.

Without a key, feeds still serve — unsigned — and peers won't mirror them. See [Join the network](index.md).

## Running federation safely

The defaults are safe; these are the settings that decide how much a stranger can do.

| Setting | Safe choice | Secure by default |
|---|---|---|
| `FED_PEERS` | List the peers you know. They start `trusted`; everything else starts `unvetted`. | yes |
| `FED_DISCOVER` | Leave at `0`, or accept that learned peers arrive disabled and wait for you to enable them. | yes (off) |
| `FED_AUTO_PROMOTE` | Leave at `0`, so only you promote a peer to `trusted`. | yes (`0`) |
| `FED_SUBMIT_SECRET` / `FED_SUBMIT_INSTANCES` | On a hub, list the spokes you expect; new spokes still arrive `unvetted`. | yes (submit off) |
| `FED_REGISTRY` / `FED_REGISTRY_DNS` + `FED_REGISTRY_KEY` | Pin the registry authority's key; DNS may only locate the document. | yes (no registry) |
| `FED_CORROBORATION_QUORUM` | Keep at least `2`, so no single peer can lift a find to Tier A. | yes (`2`) |
| `FED_CORROBORATION_REQUIRE_KNOWN` | Set `1` to answer corroboration questions only from your peers. | no (answers anyone, coarsened) |
| `FED_REVEAL_IGATE` | Leave off unless you and your peers want IGate credit to cross instances. | yes (off) |
| `FED_ALLOW_PRIVATE` | Leave off, so federation never reaches your LAN except the peers you configured. | yes (off) |
| 44net peers | Admitted `unvetted`; promote them yourself. Automatic admission trusts `DOH_URL`'s DNSSEC flag. | yes (`unvetted`) |

Keep `FED_PRIVATE_KEY` secret and rotate it with `tools/fedkey/rotatekey.mjs` if it may have leaked; peers
stop accepting the old key once its grace has passed.

## Peers and trust

Peers are rows with a **trust tier**:

| Trust | Behaviour |
|-------|-----------|
| `trusted` | Mirrored, and counted toward Tier A corroboration. Peers you list in `FED_PEERS` start here. |
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

## Next

- [Hubs, relays and the registry](hubs-and-relays.md).
- [How federation stays honest](../../reference/federation-trust.md).
