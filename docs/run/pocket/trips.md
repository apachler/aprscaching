# Before a trip: sync and your home hub

A Pocket station can follow other instances like any instance (`FED_PEERS`, [Join the network](../federation/index.md)),
usually your home instance. Out in the field it may have no data connection, so pull the caches while the
phone is on Wi-Fi:

```bash
bash ~/aprscaching/deploy/pocket/extras/sync-now.sh            # caches, deletes, keys; up to 10 pages per feed
bash ~/aprscaching/deploy/pocket/extras/sync-now.sh --finds    # finds too
```

- **Wi-Fi only** by default: without a joined Wi-Fi network (Termux:API tells) it stops; `--mobile` or
  `POCKET_SYNC_MOBILE=1` allows mobile data.
- **A data budget**: caches, deletes and callsign keys, finds only with `--finds`, and at most `--pages` pages
  of 500 records per feed and peer; a later run carries on where this one stopped. Deletes always come, so
  nothing you already hold outlives its removal.
- **One region**: `FED_SYNC_REGION=S,W,N,E` in the `.env` pulls only the caches in that box from peers that
  filter by region (a peer without the filter sends every cache). Changing it reads the caches again from the
  start. As a guide, a cache with a short description is about 0.5 KB on the wire: 300 caches took 144 KB
  in a test.
- It reports what arrived and the bytes it took, in the terminal and in a notification; `status.sh` shows
  the last sync. The Termux:Widget shortcut **Sync before trip** runs it (`extras/setup.sh --shortcuts`).

## Your home instance as the hub

The simplest network for a Pocket station is your own instance at home: the phone follows it, and pushes
what it records out in the field back to it. The phone needs no inbound connection, so this works behind a
carrier's NAT. The [setup questions](../install/pocket.md#install) set it up; by hand, in the phone's `.env`:

```bash
INSTANCE=oe8apr-pocket                     # its own name, set once
FED_PRIVATE_KEY=<node ~/aprscaching/tools/fedkey/genkey.mjs --raw>   # its own key, never the home one's
FED_PEERS=https://aprs.example.net         # follow the home instance
FED_HUB_URL=https://aprs.example.net       # push this station's records to it
FED_SUBMIT_SECRET=<the home instance's FED_SUBMIT_SECRET>
```

On the home instance, `FED_SUBMIT_SECRET` enables pushes and `FED_SUBMIT_INSTANCES` (when set) must list
`oe8apr-pocket`. The phone's first push registers it there as `unvetted`: its caches arrive, hidden on the
map by default, until you promote it once under **Instance admin → Federation**. Leave `FED_DISCOVER` off on
the phone; it follows only what you name.

**Back from a trip.** The phone remembers how far it has pushed each feed, so a restart (Termux killed, the
phone rebooted) never sends its history again. When a push fails because the phone is offline, the station
asks the home instance's `/health` again after 30 s, then less often (at most every 10 minutes), and pushes
as soon as it answers; it also asks the home instance what it already holds, so a backup restored on either
side resumes where the home instance stands. `bash ~/aprscaching/deploy/pocket/sync.sh` (or **Sync now** under
**Instance admin → Federation**) does it at once. `status.sh` shows the last push, the records still waiting
and since when the phone is offline; the home instance lists the phone with its last push, marked stale after
`FED_SPOKE_STALE_HOURS` (24 h) without one.

**Corroboration.** A station vouches for finds only from receiving sites it attests (`FIRST_PARTY_SITES`), and
a Pocket as installed attests none, so trusting it at home adds no voice to the corroboration quorum. If the
phone attests a site of its own (a USB TNC, a MeshCom node), home and phone are one operator with two keys.
A peer that added both over 44Net under your callsign counts them as one voice; one that added them any
other way, without a registry entry naming you for both, counts two. Keep the quorum honest by leaving
`FIRST_PARTY_SITES` unset on a phone that follows your home instance.

**Directly over 44Net.** Two stations on 44Net can also follow each other directly by callsign or by host
(the **Add a peer by callsign or host (44net)** field under **Instance admin → Federation**), over plain http
on their ampr.org names. A phone beside your home station publishes its own record under a name such as
`pocket.<call>.ampr.org` ([several instances under one callsign](../networks/44net-identity.md#3-name-and-identity)). The phone is reachable that way only while its tunnel is up, and with a split tunnel only
from 44Net; following your home instance (which the phone reaches itself) keeps working when it is not.

## If the phone is lost

The phone holds the station's key, the home instance's submit secret and a signed-in browser. On the home
instance:

1. **Change `FED_SUBMIT_SECRET`** and restart: the lost phone can push nothing more. Hand the new secret only
   to the replacement.
2. **Sign out everywhere** in your account settings, if you signed in to the home instance from the phone.
3. Decide about what the phone pushed before: it stays as it is, or **block** the phone under **Instance admin →
   Federation**, which hides everything it sent, the genuine records too.

A replacement phone starts fresh: install Pocket, answer the setup questions (a **new instance name and a new
key**, since the lost key is no longer yours alone), and sync from home — what the lost phone pushed is on the
home instance already. Do not restore a backup of the lost phone onto it: the backup carries the old name and
key.

## Next

- [Backups and moving](../day-to-day/backups.md).
