# Pocket: a station on an Android phone

**Pocket** runs a complete aprscaching station on one Android phone, in [Termux](https://termux.dev), without
root: the gateway (Node and SQLite) serves the map and the web app, and the ingest feeds it from APRS-IS and a
MeshCom node. It is a station for field days, demos and hikes — not a 24/7 server. Android stops background
apps, and battery and heat are real limits; for an always-on station, use [Self-host](deployment.md#self-host).

```
MeshCom node (T-Deck, T-Beam) ──Wi-Fi──▶ the phone's hotspot, or a router ── ExtUDP, UDP 1799 ──▶
Termux: tmux ─┬─ ingest   (MeshCom listener; APRS-IS while there is a data connection)
              └─ gateway  (SQLite) on port 8787, and https on 8443 for visitors
A browser on the phone ── http://localhost:8787 ── Web Bluetooth ── a BLE KISS TNC (your own traffic)
Visitors on the hotspot ── https://<hotspot address>:8443
Optional, with a data connection: a Cloudflare Tunnel, or WireGuard with 44Net Connect
```

The scripts are in `deploy/pocket/`; each takes `--help`, and the
[README](https://github.com/apachler/aprscaching/blob/dev/deploy/pocket/README.md) lists every option.

## What it is and isn't

| It is | It isn't |
|---|---|
| A whole station in a pocket: map, caches, finds, live stations, messages, off-grid | An always-on public server |
| The same gateway and ingest as every other shape; only scripts and settings are Pocket's own | A fork, a native app, or a Play Store app |
| Runnable without root and without Google services | A way to run Docker or the desktop binary on a phone |
| A MeshCom and APRS-IS station; your own BLE TNC through the browser | A trusted receiver by default: trust tiers work as on any instance |

## Install

1. Install **Termux from [F-Droid](https://f-droid.org/packages/com.termux/)** or its
   [GitHub releases](https://github.com/termux/termux-app/releases). The Play Store build is a different,
   older line; do not mix the two. Also install **Termux:API** from the same source: the scripts use it for
   the battery, the Wi-Fi name and telling the hotspot apart from a joined Wi-Fi.
2. In Termux, one command installs and starts everything:

    ```bash
    curl -fsSL https://raw.githubusercontent.com/apachler/aprscaching/main/deploy/pocket/pocket.sh | bash -s -- --call <YOURCALL>
    ```

    It upgrades Termux first (`apt-get update && apt-get dist-upgrade`, choosing a mirror with
    `termux-change-repo` when none is set), installs the packages, clones the repository to `~/aprscaching`,
    compiles `better-sqlite3` for Android, builds the web app, writes `~/.aprscaching/.env` with new secrets,
    starts the station and prints its addresses and a one-time sign-in link. Running it again upgrades,
    updates and restarts. The first run takes a few minutes; compiling `better-sqlite3` is the long part.
3. If `curl` itself fails with `cannot locate symbol "SSL_…"`, Termux is half-upgraded: run
   `apt update && apt full-upgrade -y` first.
4. After a first install `pocket.sh` offers the **setup questions**; they run any time with
   `bash ~/aprscaching/deploy/pocket/wizard.sh`. With Termux:API they are Android dialogs, otherwise questions
   in the terminal (`--text` forces those). Each shows the current value, and nothing is written until you
   confirm the summary:

    | Question | Writes |
    |---|---|
    | Your callsign, the base call | `ADMIN_CALLSIGNS` (the first entry) and `APRSIS_CALLSIGN` |
    | Instance name, e.g. `oe8apr-pocket` | `INSTANCE`: the name other instances know the station by when it federates. It is set once: caches and finds carry the name they were made under, so a station that holds any keeps `localhost` |
    | A MeshCom node now? | runs [`meshcom-setup.sh`](#a-meshcom-node) |
    | Home-screen shortcuts, a daily backup while charging | runs `extras/setup.sh` ([Extras](#extras-notification-shortcuts-battery-saver-alerts-scheduled-backup)) |

    Then it restarts a running station and opens **Instance admin** (`http://localhost:8787/?view=admin`),
    whose Setup checklist covers the rest once you are signed in.

The settings (`~/.aprscaching/.env`) suit a phone: the gateway on port 8787 on every interface, APRS-IS
receive-only with an example filter to tune, short retention for the diagnostic tables, federation off.
Every key is in [configuration](../reference/configuration.md).

## Run it

```bash
bash ~/aprscaching/deploy/pocket/start.sh      # the tmux session "aprscaching"; Ctrl-b d leaves it running
bash ~/aprscaching/deploy/pocket/status.sh     # processes, addresses, certificate, MeshCom, storage, battery
bash ~/aprscaching/deploy/pocket/restart.sh    # both processes, or: restart.sh gateway | ingest
bash ~/aprscaching/deploy/pocket/stop.sh
bash ~/aprscaching/deploy/pocket/update.sh     # pull, install, restart
```

The gateway and the ingest each run in a restart loop: 5 s after an exit, backing off to 30 s on quick
repeated failures. Their logs are in `~/.aprscaching/logs/`, rotated by size.

**Sign in.** Open `http://localhost:8787` in a browser on the phone. A passkey works where the phone's
passkey provider accepts it; on a phone without Google Play services (microG), passkeys work only on https
origins, so use the one-time link: `bash ~/aprscaching/deploy/pocket/signin-link.sh <YOURCALL>`.

## Keep it running

Android stops background work. On the tested phone, these were enough for the station to run with the screen
off:

- `start.sh` takes a **wake lock** (`termux-wake-lock`; `stop.sh` releases it).
- **Battery:** Settings → Apps → Termux → Battery → **Unrestricted**.
- Where Android still kills the processes (`status.sh` shows the restarts climbing), turn on **Disable child
  process restrictions** in the developer options (Android 14 and later). It switches off Android's limit on
  processes an app starts in the background, the phantom process killer.
- **Termux:Boot** (F-Droid) starts the station after a reboot: copy
  `deploy/pocket/boot/start-aprscaching` to `~/.termux/boot/`.
- **Heat:** the gateway, a hotspot and mobile data together warm the phone. Keep it out of direct sun, and
  on a charger for long sessions.

## Extras: notification, shortcuts, battery saver, alerts, scheduled backup

Three optional add-ons, each from F-Droid (or each from GitHub). **Install every Termux app from the same
source as Termux itself:** the apps share a signing key, and apps from different sources refuse to talk to
each other. Open each app once after installing it, and grant the permissions it asks for (notifications
for Termux:API).

| Add-on | Gives the station |
|---|---|
| **Termux:API** (the app and `pkg install termux-api`) | a status notification, the battery saver, field alerts, the battery and Wi-Fi lines in `status.sh`, the scheduled backup |
| **Termux:Widget** | home-screen shortcuts |
| **Termux:Boot** | start at boot ([above](#keep-it-running)) |

Without an add-on, the scripts print one line saying what to install and work as before.

- **Status notification.** With Termux:API, `start.sh` keeps one ongoing notification current every
  minute: running or stopped, the stations heard in the last hour, when the MeshCom node was last heard,
  whether APRS-IS delivers, and the battery. Its buttons are **Stop**, **Restart** and **Open map**; tapping
  it opens the map. It reads the gateway's `/api/admin/station-status` with the station's `OPERATOR_SECRET`.
  `stop.sh` removes it.
- **Shortcuts.** `bash ~/aprscaching/deploy/pocket/extras/setup.sh --shortcuts` puts **Status**, **Start**,
  **Stop**, **Open map** and **Backup** into `~/.shortcuts/`; add the Termux:Widget widget to the home
  screen to tap them. Status opens a terminal with `status.sh`; the others run in the background and report
  with a short toast.
- **Battery saver.** With Termux:API, `start.sh` also watches the battery. Below `POCKET_BATTERY_LOW`
  percent (default 20) on battery, the station switches to a saver profile: APRS-IS narrowed to your own
  call's packets (the connection stays up, almost no data flows), the raw packet log kept 2 hours; MeshCom
  and every radio port stay on. It switches back when the phone charges or the battery is 10 points above
  the threshold, and says so in a notification each time. The profile is an overlay,
  `~/.aprscaching/battery-saver.env`, applied by restarting both processes; `POCKET_BATTERY_LOW=0` turns
  the saver off.
- **Field alerts** (off by default). With `POCKET_ALERTS=1` in the `.env`, a new direct message to your call
  (any SSID of `ADMIN_CALLSIGNS`, from MeshCom or APRS) makes the phone vibrate within 15 seconds;
  `POCKET_ALERTS_SPEAK=1` also says who it is from ("Message from O E 8 X Y Z"). The message itself is
  read out only with `POCKET_ALERTS_SPEAK_BODY=1`: it may be private, and the phone speaks to everyone
  around it. Each message is announced once, also across restarts.
- **Your position.** The phone's GPS reaches the station through the browser: the map's location button,
  and a find's device location, which is what can make it app-corroborated (Tier B). No script reads the
  GPS on its own.
- **Scheduled backup.** `extras/setup.sh --scheduled-backup` registers `backup.sh` with Android's job
  scheduler: once a day, only while the phone charges and the battery is above 50 %. `status.sh` shows the
  last backup. `extras/setup.sh --remove` takes both back.

## Browsers on the phone

| Browser | Map | Location | Passkeys (microG phone) | Web Bluetooth |
|---|---|---|---|---|
| **Brave** | works | works out of the box | no passkey offered; use the one-time link | off by default: `brave://flags` → *Web Bluetooth API* → Enabled |
| **Firefox** | works | needs Settings → Site permissions → Location → **Ask to allow** | "Operation is not supported"; use the one-time link | not supported |
| **Cromite** | needs WebGL allowed for the site | crashes the browser | no passkey offered | — |
| Chrome | works | works | works with Google Play services | works |

Brave is the recommended browser on a phone without Google services. Without WebGL, the app shows a notice
and works without the map.

## Visitors over https

A visitor's browser grants location and keeps a sign-in only on a secure origin; `http://localhost` is one
on the phone itself, `http://<hotspot address>:8787` is not. One command gives the gateway an https listener:

```bash
bash ~/aprscaching/deploy/pocket/tls.sh
bash ~/aprscaching/deploy/pocket/signin-link.sh --hotspot <THEIR CALL>   # per visitor: a link and a QR code
```

- The station makes **its own CA** once, name-constrained to private and loopback addresses, so a visitor
  who installs it trusts it for nothing on the internet. The station certificate names the phone's private
  addresses (hotspot, joined Wi-Fi, tethering), is valid 30 days, and is issued again within 30 s when a new
  address appears (the tmux window `tls`) — without restarting the gateway.
- Visitors accept the certificate warning once, or install the CA from
  `http://<hotspot address>:8787/pocket-ca.crt` (`status.sh` prints its fingerprint). Chrome and Brave trust
  an installed CA; Firefox for Android only with *Use third party CA certificates* in its secret settings.
- `tls.sh` also sets `OPERATOR_LINKS_FOR_ANY_CALL=1`, so the operator's link can sign in any call. Keep
  `OPERATOR_SECRET` to yourself, and run `tls.sh --disable` before anyone else operates the station.
- A visitor's account starts unverified and logs finds only under the visitor's own call.

## A MeshCom node

A MeshCom node sends everything it handles to the ingest over ExtUDP. It joins the phone's **hotspot** (off
grid, flight mode is fine) or the **router** the phone has joined:

```bash
bash ~/aprscaching/deploy/pocket/meshcom-setup.sh
```

The script finds the network — it asks when both the hotspot and a Wi-Fi are up — prints the commands to
enter on the node, writes `MESHCOM_NODE` and restarts the ingest. It never sends anything to the node.

- **On the hotspot** the node gets a fixed address high in the hotspot's subnet (`--setownip`, `--setowngw`,
  `--setownms`, then `--extudpip <the phone>` and `--extudp on`).
- **On a router** the router hands out the addresses: reserve one for the node and one for the phone in its
  DHCP settings; the script prints only `--setssid`, `--setpwd`, `--extudpip` and `--extudp on`.
- The node needs MeshCom firmware 4.35t built on or after 2026-09-25, or newer.
- The listener binds the phone's address on the node's network when the ingest starts: bring the hotspot or
  the Wi-Fi up first, or run `restart.sh ingest` afterwards (`status.sh` says when).

To check the data flow: `grep -F '[meshcom]' ~/.aprscaching/logs/ingest.log` shows the listener and, every
10 minutes, a counters line; `curl -s http://127.0.0.1:8787/api/ports` counts `meshcom` packets. On the map,
turn on **Search & filter → Live stations**: the node appears after its next beacon, and its page's
**Raw packets** name the `meshcom` port. MeshCom in general is on the [MeshCom](meshcom.md) page; its trust
rules hold here unchanged — a direct hearing by your node counts toward Tier A only once its call is in
`FIRST_PARTY_SITES`, which the scripts never set.

## A USB TNC on the phone

A KISS TNC on the phone's USB-C port (through an OTG adapter) feeds the ingest directly, so the phone logs
**every** station the TNC hears, off-grid — the browser's Bluetooth path forwards only your own traffic
unless it has the ingest secret. Android gives USB access per app: `termux-usb` (Termux:API) hands a file
descriptor to `extras/usb_kiss_bridge.py`, which drives the TNC as a CDC-ACM serial port through libusb and
serves KISS over TCP on `127.0.0.1:8001`, where the ingest connects.

```bash
pkg install termux-api python libusb
bash ~/aprscaching/deploy/pocket/extras/usb-kiss.sh --list
bash ~/aprscaching/deploy/pocket/extras/usb-kiss.sh --setup --baud 9600    # Android asks once for permission
```

`--setup` writes `USB_KISS_DEVICE`, `USB_KISS_BAUD`, `KISS_TNC_HOST=127.0.0.1` and `KISS_TNC_PORT` to the
`.env`; `start.sh` then runs the bridge in the tmux window `usb-kiss`, which waits for the TNC and restarts
the bridge when it is unplugged and plugged in again. Set `RF_SITE_CALL` to this station's call to name it
as the receiving site. What the TNC hears is a local TNC's hearing like any other: it counts toward Tier A
only once `RF_SITE_CALL` is in `FIRST_PARTY_SITES`, and your own receiver never corroborates your own finds.

**Only CDC-ACM devices** work, since they need no driver of their own; the bridge refuses FTDI, Silicon Labs
CP210x, WCH CH340 and Prolific chips by name.

| TNC | USB | Status |
|---|---|---|
| A TNC or radio with a native USB CDC-ACM port (e.g. a KISS TNC on an ESP32-S3 or RP2040) | CDC-ACM | untested |
| TNCs on an FTDI, CP210x or CH340 USB-serial chip | vendor-specific | incompatible (refused by name) |

Only owner-tested entries are marked tested; report yours with the `status.sh` output.

**Receive-only by default.** The bridge drops everything the ingest would send toward the radio. It passes
KISS data frames only when all three hold: `USB_KISS_TX=1` in the `.env`, your callsign control-verified on
this station, and the bridge started by `usb-kiss.sh` (which checks both). A watchdog then allows 6 frames a
minute, 3 in a burst, each at most 330 bytes, and never the KISS "exit" command; `status.sh` and the station
notification show "TX ON". The phone is then an automatic station under your licence — often unattended, in
a pocket, able to crash or run flat. Read [Amateur-radio compliance](rf-regulatory.md) first, and enable
the ingest's transmit features (digipeater, IGate, radio replies) deliberately, as on any ingest box.

The bridge is written from the USB CDC-ACM class specification; prior art: [Termux_CDC_ACM](https://github.com/schuhumi/Termux_CDC_ACM)
and pyusb's Termux file-descriptor work ([pyusb#287](https://github.com/pyusb/pyusb/pull/287), not merged, so
the bridge calls libusb through Python's `ctypes` instead).

## An RTL-SDR on the phone: not supported

An RTL-SDR dongle with Direwolf would make the phone an RF receiver without a TNC. On Termux today this
does not work, for three independent reasons (checked in the `termux/termux-docker` image and upstream, as
of September 2026):

| Piece | State |
|---|---|
| Packages | Neither `rtl-sdr` nor `direwolf` is a Termux package. |
| rtl-sdr from source | Builds (`rtl_fm`, `rtl_tcp`, `rtl_sdr`, `rtl_power`; `rtl_adsb` fails because Android's C library has no `pthread_cancel`). It **cannot open the dongle**: librtlsdr finds devices by scanning the USB bus, which Android forbids an app without root, and it has no call that takes the file descriptor `termux-usb` hands over. A patch adding one (`rtlsdr_open_fd`) was posted to the osmocom-sdr list and not merged. |
| Direwolf from source | Does not build unmodified: it needs ALSA or OSS sound headers, which Termux does not ship. Reading audio only from stdin (`rtl_fm … \| direwolf -r 24000 -`) would need a patch. |
| CPU, battery, heat | Not measured: nothing runs far enough to measure. |

Were it to work, an SDR would be one more local receiver: what it hears counts toward Tier A only once
`RF_SITE_CALL` is in `FIRST_PARTY_SITES`, and your own receiver never corroborates your own finds.

Pocket therefore installs neither. For RF on the phone use a TNC — [on USB](#a-usb-tnc-on-the-phone), or
[over Bluetooth in the browser](#your-radio-in-the-browser) — or a MeshCom node; for an SDR receiver run
`rtl_fm | direwolf` on a Raspberry Pi as the station's [ingest box](rf-ingest.md).

## Your radio in the browser

The browser on the phone can connect a Bluetooth Low Energy KISS TNC (a Mobilinkd, for instance) through Web
Bluetooth — see [Your radio in the browser](../guides/my-radio.md). In Brave, enable *Web Bluetooth API* in
`brave://flags` first. What the browser forwards to the station depends on how it signs in:

- **signed (YOURCALL)** forwards only your own station's packets (any SSID of your call); everything else
  your radio hears stays in the browser.
- **secret (self-host)** — paste the station's `INGEST_SECRET` (`grep INGEST_SECRET ~/.aprscaching/.env`)
  with the gateway base URL `http://localhost:8787`: then everything your radio hears is forwarded. The
  secret stays in the page's memory and is asked for again after a reload.

Either way, what the browser forwards is **Tier C** — never evidence for a find. The browser session ends
when the page closes; for a TNC heard around the clock, other routes feed the same station: a MeshCom node,
APRS-IS, or a KISS-over-TCP TNC the ingest connects to ([RF ingest](rf-ingest.md)).

## Reaching it from the internet

Mobile networks put the phone behind the carrier's NAT: without help, the station is reachable only on its
hotspot and on a Wi-Fi it has joined. Two optional routes, both off by default:

- **Cloudflare Tunnel** — `pkg install cloudflared`, a named tunnel from the Cloudflare dashboard with its
  public hostname pointing at `http://localhost:8787`, and `APP_URL=https://<your hostname>` in the `.env`.
  Leave `TRUST_CF` unset: the hotspot stays a direct way in.
- **WireGuard and 44Net Connect** — the WireGuard app carries a fixed 44.x address for the whole phone, and
  the gateway answers on it; see [Pocket on 44Net](#pocket-on-44net).

The [README](https://github.com/apachler/aprscaching/blob/dev/deploy/pocket/README.md#reaching-the-station-from-the-internet)
has the commands.

## Pocket on 44Net

With [44Net Connect](44net.md), ARDC's WireGuard service, the phone gets a fixed 44.x address, and the
station a callsign-verified name to federate under. Termux cannot run WireGuard without root, so the
**WireGuard app** carries the tunnel for the whole phone: import the configuration the ARDC portal issues
for the phone, and turn on *Always-on VPN* for it in Android's VPN settings so the tunnel comes back after
a network change. Android runs one VPN at a time.

!!! warning "Which traffic takes the tunnel"
    Android routes by the tunnel's `AllowedIPs`, and without root nothing can route by source address. So
    the choice is all or little:

    - **Split tunnel** (`AllowedIPs` covering 44Net only): the rest of the phone's traffic stays on mobile
      data or Wi-Fi, but only 44Net hosts can reach the station on its 44.x address. A reply to anyone else
      leaves by mobile data, from the carrier's address, and never arrives.
    - **Full tunnel** (`AllowedIPs = 0.0.0.0/0`): the station is reachable from the whole internet on its
      44.x address, and **every** app's traffic runs through ARDC.

    **Unverified:** which `AllowedIPs` the configuration 44Net Connect issues uses, and whether ARDC's
    policy covers a phone's whole traffic in a full tunnel; check the file you imported and ARDC's terms.

- **Test inbound.** **Unverified:** whether Android delivers inbound connections on the VPN interface to
  Termux on every phone. Open `http://<44.x address>:8787/health` from another network before you rely on it.
- **Exposure.** The gateway listens on every interface, the tunnel included, and 44Net Connect filters
  nothing ([Who can reach you](44net.md#6-who-can-reach-you)): port 8787, and 8443 with https on, answer on
  the 44.x address. So does anything else running in Termux, such as `sshd` on 8022; stop it (`pkill sshd`)
  while the tunnel is up. `status.sh` shows *44Net: up* with this warning, and the station notification shows
  *44Net: up (44.x)*.
- **The hotspot and a MeshCom node** stay on the phone's own networks. **Unverified:** that the hotspot and
  ExtUDP keep working with a full tunnel up on every phone; `status.sh` shows whether the node's listener
  still runs.
- **Federation.** Publish the `_aprscaching` TXT record and add the 44net endpoint to `FED_ENDPOINTS` as in
  [44Net steps 3 and 4](44net.md#3-name-and-identity), then run the self-check under **Instance admin →
  Setup → 44Net**. The phone needs its own instance name (the [setup questions](#install)) and its own key.
- **https on the 44Net name.** A browser grants passkeys and location only to https. For members who open
  the station by its ampr.org name, `extras/ampr-cert.sh` obtains a Let's Encrypt certificate with a
  DNS-01 record you add in the ARDC portal:

    ```bash
    pkg install lego
    bash ~/aprscaching/deploy/pocket/extras/ampr-cert.sh --host <call>.ampr.org --use
    ```

    It prints the `_acme-challenge` TXT record to add, checks DNS every minute until the portal has
    published it (about once an hour), lets lego finish, and with `--use` serves the certificate on the
    https port. That certificate names only the ampr.org name: hotspot visitors who open the station by
    address then see a name warning, and `tls.sh` switches back to the station certificate. Each renewal
    repeats the record; `status.sh` warns 14 days before the certificate expires.
    [TLS on the 44Net name](44net.md#tls-on-the-44net-name) has the background.

## Federation: sync before a trip

A Pocket station can follow other instances like any instance (`FED_PEERS`, [Federation](../guides/federation.md)),
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

## Backup

```bash
termux-setup-storage                                  # once: allow Termux to write to shared storage
bash ~/aprscaching/deploy/pocket/backup.sh            # to ~/storage/shared/aprscaching-backups/
```

A consistent snapshot of the database taken while the gateway runs, with the `.env`, `session.secret` and
media; the newest 7 are kept. Shared storage is readable by any app with storage permission: `--no-env`
leaves the secrets out. `backup.sh --restore FILE` puts one back. The station CA stays on the phone; a station
restored elsewhere makes a new one.

## Tested on

| Phone | Android | Termux | Node | Result |
|---|---|---|---|---|
| SHIFTphone 8 (SHIFTOS-L, microG, no Google services) | 15 | 0.118.3 (F-Droid) | 24.18.0 | install (`better-sqlite3` compiled in 2 min 35 s); restart after a killed gateway; 45 min screen off with Termux battery unrestricted and the child-process limit on, nothing killed; backup; https for a visitor on the hotspot with location; a MeshCom node through the home router and on the hotspot in flight mode |

The weekly `pocket-termux` workflow installs and starts Pocket in the `termux/termux-docker` image on
aarch64, the phones' architecture, with everything built inside Termux, and on x86_64 with the web app built
on the runner and handed in with `--web-dist`: Rolldown, the web build's bundler, has Android builds for arm
only, so an x86 Android device (a Chromebook, an emulator) takes its web build from a PC. The image has no
Android underneath, so it proves the install and the scripts, not the phone's background limits.

## Alternatives, not supported

[Podroid](https://github.com/ExTV/Podroid) runs Podman and Docker in an Alpine Linux VM on Android, and
Android's own **Linux Terminal** (a Debian VM under *Developer options → Linux development environment*,
first on Pixel phones) runs ordinary Linux software. Either could run the Docker stack or the desktop binary,
but neither is tested here: the VM's network sits behind the phone, the hotspot and Bluetooth are not the VM's
own, and the phone still stops background work. Pocket uses Termux, which runs on the phone itself.
