# Before a trip: sync and your home hub

This page shows the sysop how a Pocket station follows a home instance. At the end the phone holds the caches of
your area before it loses signal, and pushes what it records in the field back home.

## Before you start

- Pocket runs on the phone ([Run Pocket in the field](field-station.md)).
- A home instance on a public URL, with `FED_SUBMIT_SECRET` set if the phone pushes to it
  ([Push to a hub](../federation/hubs-and-relays.md#push-to-a-hub)).
- **Termux:API**, so the scripts can tell Wi-Fi from mobile data ([Pocket extras](extras.md)).

## Sync before a trip

A Pocket station follows other instances like any instance, through `FED_PEERS`
([Join the network](../federation/index.md)). Out in the field it may have no data connection, so pull the caches
while the phone is on Wi-Fi:

```bash
bash ~/aprscaching/deploy/pocket/extras/sync-now.sh            # caches, deletes and keys; up to 10 pages per feed
bash ~/aprscaching/deploy/pocket/extras/sync-now.sh --finds    # finds too
```

- **Wi-Fi only** by default. Without a joined Wi-Fi network it stops; `--mobile` or `POCKET_SYNC_MOBILE=1`
  allows mobile data.
- **A data budget.** It pulls caches, deletes and callsign keys, and finds only with `--finds`. It takes at most
  `--pages` pages (1 to 50, default 10) of 500 records per feed and peer; a later run carries on where this one
  stopped. Deletes always come, so nothing you hold outlives its removal.
- **One region.** `FED_SYNC_REGION=S,W,N,E` in the `.env` pulls only the caches in that box, from peers that
  filter by region. Changing it reads the caches again from the start. As a guide, a cache with a short
  description is about 0.5 KB on the wire: 300 caches took 144 KB in a test.

It reports what arrived and the bytes it took, in the terminal and in a notification. `status.sh` shows the last
sync. The Termux:Widget shortcut **Sync before trip** runs it (`extras/setup.sh --shortcuts`).

## Your home instance as the hub

The simplest network for a Pocket station is your own instance at home: the phone follows it, and pushes what it
records in the field back to it. The phone needs no inbound connection, so this works behind a carrier's NAT.

1. **On the home instance**, set `FED_SUBMIT_SECRET`, and add the phone's instance name to
   `FED_SUBMIT_INSTANCES` when that list is set. Restart it.
2. **On the phone**, answer the [setup questions](../install/pocket.md#install), or set these in
   `~/.aprscaching/.env` and run `restart.sh gateway`:

    ```bash
    INSTANCE=oe8apr-pocket                     # its own name, set once
    FED_PRIVATE_KEY=<node ~/aprscaching/tools/fedkey/genkey.mjs --raw>   # its own key, never the home one's
    FED_PEERS=https://aprs.example.net#<fingerprint>   # follow the home instance, its key fingerprint pinned
    FED_HUB_URL=https://aprs.example.net       # push this station's records to it
    FED_SUBMIT_SECRET=<the home instance's FED_SUBMIT_SECRET>
    ```

    The fingerprint is the home instance's, from **Instance admin → Federation → Your key fingerprint** there.
    With it the phone trusts the home instance once its key matches. The setup questions add the home instance
    without one: it starts `unvetted` on the phone, so trust it under the phone's **Instance admin →
    Federation** after comparing the fingerprint its row shows.

3. **On the home instance**, promote the phone once under **Instance admin → Federation**. Its first push
   registers it `unvetted`, so its caches arrive hidden on the map until you do.

The phone follows only what you name. The instances its trusted peers list, and stations on the same hotspot (it
listens for them by mDNS), wait under **Discovered**, switched off until you follow one
([Field discovery on a LAN](../federation/index.md#field-discovery-on-a-lan)).

### Back from a trip

The phone pushes on its own once the home instance answers again, and resumes where it stopped
([Push to a hub](../federation/hubs-and-relays.md#push-to-a-hub)). To push and pull at once:

```bash
bash ~/aprscaching/deploy/pocket/sync.sh
```

**Sync now** under **Instance admin → Federation** does the same. `status.sh` and `sync.sh --status` show the last
push, the records still waiting and since when the phone is offline. The home instance lists the phone with its
last push, marked stale after `FED_SPOKE_STALE_HOURS` (24) without one.

### Corroboration

A station vouches for finds only from receiving sites it trusts (**Instance admin → Trusted receiving
stations**, or `FIRST_PARTY_SITES`). A Pocket as installed
attests none, so trusting it at home adds no voice to the corroboration quorum.

If the phone attests a site of its own (a USB TNC, a MeshCom node), home and phone are one operator with two keys.
A peer that added both over 44Net under your callsign counts them as one voice. A peer that added them any other
way, without a registry entry naming you for both, counts two. Keep the quorum honest: trust no receiving station on a phone
that follows your home instance, neither in Instance admin nor in `FIRST_PARTY_SITES`.

### Directly over 44Net

Two stations on 44Net can also follow each other directly, by callsign or by host: **Add a peer by callsign**
under **Instance admin → Federation**, over plain http on their ampr.org names. A phone beside your home station
publishes its own record under its own name, by default `aprscaching-pocket.<call>.ampr.org`
([Several instances under one call](../networks/44net-identity.md#several-instances-under-one-call)).

The phone is reachable that way only while its tunnel is up, and with a split tunnel only from 44Net
([Pocket on 44Net](44net.md#pocket-on-44net)). Following your home instance, which the phone reaches itself, keeps
working when it is not.

## If the phone is lost

The phone holds the station's key, the home instance's submit secret and a signed-in browser. On the home
instance:

1. **Change `FED_SUBMIT_SECRET`** and restart: the lost phone can push nothing more. Hand the new secret only to
   the replacement.
2. **Sign out everywhere** in your account settings, if you signed in to the home instance from the phone.
3. **Decide about what the phone pushed before.** It stays as it is, or **block** the phone under **Instance admin
   → Federation**, which hides everything it sent, the genuine records too.

A replacement phone starts fresh. Install Pocket and answer the setup questions with a **new instance name and a
new key**, since the lost key is no longer yours alone. Then sync from home: what the lost phone pushed is on the
home instance already. Do not restore a backup of the lost phone onto it, since the backup carries the old name
and key.

## Check that it worked

- `status.sh` shows the last sync and the last push.
- On the home instance, **Instance admin → Federation** lists the phone as a spoke with its last submission.

## Next

- [Backups and moving](../day-to-day/backups.md#pocket): keep a copy of the station off the phone.
- [Hubs, relays and the registry](../federation/hubs-and-relays.md): the hub side in full.
