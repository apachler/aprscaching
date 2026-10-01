# deploy/pocket/

**Pocket** runs the gateway (`servers/node`, SQLite) and the ingest (`apps/ingest`) on an Android phone
in [Termux](https://termux.dev), without root: a field-day or demo station, not a 24/7 server. Android
stops background apps, and battery and heat are real limits.

| File | Purpose |
|---|---|
| `pocket.sh` | the one-command install: upgrades Termux with `apt-get`, runs `install.sh` from the same branch, starts the station and prints its URLs and a one-time sign-in link; safe to re-run |
| `install.sh` | installs the Termux packages, clones or updates `~/aprscaching`, installs only what the gateway, the ingest and the web build need, compiles better-sqlite3 for Android, builds the web app, writes `~/.aprscaching/.env` on the first run and starts the gateway once to apply the migrations; safe to re-run |
| `.env.pocket.example` | the settings `install.sh` starts from: gateway on port 8787, ingest to localhost, APRS-IS, short retention, federation off |
| `start.sh` | starts the tmux session `aprscaching` (windows `gateway`, `ingest`, `logs`, `shell`, and `tls` with https on) with a wake lock, or attaches to it; `--no-attach`, `--gateway-only` |
| `stop.sh` | stops the ingest and the gateway (SIGTERM, then SIGKILL after a grace period), closes the session, releases the wake lock |
| `status.sh` | the processes (uptime, restarts), `/health`, the URLs other devices use on each network (the hotspot included, http and https), a warning on a joined Wi-Fi network, the https certificate (and a warning 14 days before the ampr.org one expires), 44Net with its exposure warning, storage, database size, battery |
| `update.sh` | runs `install.sh` for the current branch, then restarts both processes; the gateway migrates on start |
| `backup.sh` | database snapshot, `.env` and media to shared storage, keeps the newest 7; `--restore FILE` |
| `signin-link.sh` | a one-time sign-in link for a callsign, for a browser where the passkey does not work; `--hotspot` for a visitor, with a QR code |
| `restart.sh` | restarts the gateway, the ingest or both in the running station (after editing the `.env`, or once the hotspot is on for a MeshCom node) |
| `wizard.sh` | the setup questions after install, in Android dialogs (Termux:API) or the terminal: callsign, instance name (set once), a MeshCom node, shortcuts, the scheduled backup, the home instance to follow and push to (with a signing key of the station's own); shows the current values, writes nothing until the summary is confirmed, then opens Instance admin; `--text`, `--dry-run` |
| `meshcom-setup.sh` | a MeshCom node on the hotspot or on the router the phone has joined (asks when both are up): finds the network, suggests a fixed address for the node on the hotspot, prints the commands to enter on the node, writes `MESHCOM_NODE` and restarts the ingest; never sends anything to the node |
| `extras/notify.sh` | the ongoing status notification with Stop, Restart and Open map (Termux:API); `start.sh` runs it |
| `extras/battery.sh` | the battery saver: below `POCKET_BATTERY_LOW` % on battery, APRS-IS narrowed to your own call and a 2-hour raw log, back when charging or 10 points higher (Termux:API); `start.sh` runs it |
| `extras/alerts.sh` | field alerts (off by default, `POCKET_ALERTS=1`): vibrate, and optionally speak the sender, for a new direct message to your call (Termux:API); `start.sh` runs it |
| `extras/usb-kiss.sh` | a USB KISS TNC on OTG: `--list`, `--setup` (writes the `.env`), and the run loop `start.sh` keeps in the window `usb-kiss`; receive-only unless `USB_KISS_TX=1` and the operator's call is control-verified |
| `extras/usb_kiss_bridge.py` | the bridge itself: libusb through `ctypes` on the fd `termux-usb` hands over, CDC-ACM, KISS over TCP on `127.0.0.1:8001` for one client, a transmit watchdog; `extras/test/` holds its tests |
| `extras/ampr-cert.sh` | a Let's Encrypt certificate for the station's ampr.org name by manual DNS-01 with lego: prints the `_acme-challenge` TXT record, polls DNS until the portal publishes it, lets lego finish; `--use` serves it on the https port |
| `extras/sync-now.sh` | sync before a trip: a narrowed pull from the federation peers (caches, deletes, keys; finds with `--finds`; `--pages` per feed), on Wi-Fi only unless `--mobile`; reports the records and bytes, in a notification too |
| `extras/setup.sh` | home-screen shortcuts (Termux:Widget, Sync before trip among them) and a daily backup while charging (Termux:API); `--remove` |
| `extras/scheduled-backup.sh` | the job the scheduled backup runs: battery above 50 %, `backup.sh`, the time for `status.sh` |
| `tls.sh` | https for visitors on the hotspot: a station CA, a certificate for the phone's private addresses, the https settings in the `.env`; `--renew`, `--disable` |
| `supervise.sh`, `lib.sh` | the restart loop `start.sh` runs in each window, and the code the scripts share |
| `boot/start-aprscaching` | optional [Termux:Boot](https://f-droid.org/packages/com.termux.boot/) script: starts the station at boot |
| `test/linux-smoke.sh` | checks `pocket.sh`, recovery, status, backup, `tls.sh`, `meshcom-setup.sh`, `restart.sh` and stop on a Linux box with tmux (not part of CI) |
| `test/wizard-test.sh` | fixture tests for `wizard.sh`: terminal and dialog answers, validation, rerun, cancel, `--dry-run`, the home instance; CI runs it |
| `test/net44-test.sh` | fixture tests for the 44Net address, ampr.org names, the expiry check and `extras/ampr-cert.sh` with a fake lego and DNS; CI runs it |
| `test/termux-ci.sh` | installs and starts Pocket inside the `termux/termux-docker` image; the weekly `pocket-termux` workflow runs it on x86_64 and aarch64 |

Every script takes `--help`, and `--dir` / `--data-dir` (or `APRSCACHING_DIR` / `APRSCACHING_DATA`) when the
checkout or the data are not in `~/aprscaching` and `~/.aprscaching`.

## Install

Use Termux from [F-Droid](https://f-droid.org/packages/com.termux/) or its
[GitHub releases](https://github.com/termux/termux-app/releases), then in Termux, one command:

```bash
curl -fsSL https://raw.githubusercontent.com/apachler/aprscaching/main/deploy/pocket/pocket.sh | bash -s -- --call <YOURCALL>
```

`pocket.sh` upgrades Termux (`apt-get update && apt-get dist-upgrade`, after `termux-change-repo` when no mirror is
chosen yet and a terminal is attached), runs `install.sh` from the same branch with the options passed on, starts the station and
prints its URLs (on the phone and on the hotspot) and a one-time sign-in link. The link is the way in where
a passkey does not work, e.g. in Firefox or on a phone without Google services. Running it again upgrades,
updates and restarts the station; `bash pocket.sh --help` lists the options (`--branch`,
`--gateway-only`, `--no-start`, and every `install.sh` option).

It upgrades with `apt-get`, not `pkg`: `pkg` itself runs `curl`, and a half-upgraded Termux (a new `curl`
against an older OpenSSL) stops `curl` with `cannot locate symbol "SSL_…"` until the upgrade completes.
The scripts call `apt-get` rather than `apt`, whose command line is meant for people and prints
"apt does not have a stable CLI interface" when a script runs it; typed by hand, `apt` is fine.
If that already stops the `curl` above, run `apt update && apt full-upgrade -y` first.

The steps one by one, with `install.sh` alone:

```bash
apt update && apt full-upgrade -y   # bring every package to one consistent version first
termux-change-repo                  # pick a mirror group if pkg reports that none is selected
curl -fsSLO https://raw.githubusercontent.com/apachler/aprscaching/main/deploy/pocket/install.sh
bash install.sh --call <YOURCALL>
```

`bash install.sh --help` lists its options (another branch or repository, a web build copied from a PC,
a dry run).

### The settings

`install.sh` writes `~/.aprscaching/.env` from `.env.pocket.example` once, with new secrets, your call and
the paths, and keeps it on every later run. The profile suits a phone:

- the gateway on port 8787 on every interface, `APP_URL=http://localhost:8787`, the ingest posting to
  `127.0.0.1`;
- APRS-IS receive-only (passcode `-1`) with a 300 km example filter; tune `APRSIS_FILTER` to where you
  operate. Offline, the ingest retries with a backoff;
- `RETENTION` keeps the raw packet log 6 h, weather and telemetry 7 days, port counters and the node MHeard
  list 3 days. Logger positions, finds and accounts are not affected;
- federation off (no `FED_*` settings), no TAK/CoT or other transports, no write budget (SQLite has no
  per-row cost);
- MeshCom off until `meshcom-setup.sh` writes `MESHCOM_NODE`.

If your `.env` has no `RETENTION` line, copy it from `.env.pocket.example` and run `restart.sh gateway`.
Every key is in [configuration](../../docs/reference/configuration.md).

## Run

```bash
bash ~/aprscaching/deploy/pocket/start.sh           # Ctrl-b d detaches; the station keeps running
bash ~/aprscaching/deploy/pocket/status.sh
bash ~/aprscaching/deploy/pocket/stop.sh
bash ~/aprscaching/deploy/pocket/update.sh          # --branch dev, --pkg to upgrade Termux too
```

A browser on the phone opens the station at `http://localhost:8787`. Brave and Firefox both work; Firefox needs
Settings → Site permissions → Location set to "Ask to allow" for the map's location button. Where a passkey does
not work there (phones without Google Play services, such as microG builds, accept passkeys only on https
origins), `signin-link.sh <CALL>` prints a one-time sign-in link.

`status.sh` names the Wi-Fi network the phone has joined only when Termux:API holds Android's location
permission (Settings → Apps → Termux:API → Permissions); without it the network shows by address alone.

The gateway and the ingest each run in a restart loop, like the systemd units: 5 s after an exit, doubling on
quick repeated failures up to 30 s. Their output is in `~/.aprscaching/logs/gateway.log` and `ingest.log`,
rotated at 1 MiB with three older files kept (`APRSCACHING_LOG_MAX_KB`, `APRSCACHING_LOG_KEEP`).

The gateway listens on every interface, so devices on the phone's hotspot reach it at the address
`status.sh` lists for the hotspot; on a Wi-Fi network the phone has joined, so does everyone on that network.

Android stops background work: `start.sh` takes a wake lock, but also exempt Termux from battery
optimisation (Settings → Apps → Termux → Battery → Unrestricted). That was enough for 45 minutes with the
screen off on a SHIFTphone 8 (Android 15). Where Android still kills the processes (`status.sh` shows the
restarts), turn on *Disable child process restrictions* in the developer options on Android 14 and later
(the phantom process killer).

To start the station at boot, install Termux:Boot from F-Droid, open it once, then:

```bash
mkdir -p ~/.termux/boot
cp ~/aprscaching/deploy/pocket/boot/start-aprscaching ~/.termux/boot/
chmod +x ~/.termux/boot/start-aprscaching
```

It waits 30 s after boot (`APRSCACHING_BOOT_DELAY`), then runs `start.sh --no-attach`; its output is in
`~/.aprscaching/logs/boot.log`. Delete the copy to stop starting at boot.

## A MeshCom node on the hotspot

A MeshCom node (a T-Deck, T-Beam or Heltec on 70 cm) joins the phone's hotspot as a Wi-Fi client and sends
everything it handles to the ingest over ExtUDP. Positions and messages then appear on the map with no
internet at all: flight mode with the hotspot on is enough. The node needs MeshCom firmware 4.35t built on
or after 2026-09-25, or newer; older builds can crash with ExtUDP on.

With the hotspot on:

```bash
bash ~/aprscaching/deploy/pocket/meshcom-setup.sh
```

1. It finds the hotspot's address and subnet (Android picks them, and they differ between phones).
2. It suggests a fixed address for the node high in that subnet, away from the phone and from the devices
   the phone currently sees. A fixed address keeps the node's entry in `MESHCOM_NODE` valid; the ingest
   accepts datagrams only from the addresses listed there. The hotspot's DHCP server could still hand that
   address to another device; with a few devices on the hotspot this is unlikely, and `status.sh` shows
   who answers.
3. It prints the commands to enter on the node, through its serial console, the MeshCom app or its web
   page. It never sends anything to the node:

    ```
    --setssid <the hotspot name>
    --setpwd <the hotspot password>
    --setownip 192.168.43.200
    --setowngw 192.168.43.1
    --setownms 255.255.255.0
    --extudpip 192.168.43.1
    --extudp on
    ```

    `--setownip`, `--setowngw` and `--setownms` give the node its fixed address (MeshCom 4.34i and later).
    `--extudpip` points ExtUDP at the phone.
4. It writes `MESHCOM_NODE=<node address>=<node call>` to the `.env`, keeping any other node, and restarts
   the ingest. The ingest log then shows `[meshcom] listening udp/1799 on <phone> for <node>`.

**Through a router instead.** With the phone joined to a Wi-Fi network, the script can use that network. It
uses whichever of the two is up; with both up it asks which one the node joins (`--hotspot` or `--wifi`
answer without asking). On a router the node joins the router's Wi-Fi, and the router's DHCP server stays
in charge of the addresses. The script prints only `--setssid`, `--setpwd`, `--extudpip <the phone>` and
`--extudp on`, and asks for the address the router reserves for the node (`--node-ip`). Reserve an address
for the phone as well, since the node sends to it; Android keeps one random MAC address per network, and a
network set to use the device MAC keeps it for certain. Telling the hotspot from a joined Wi-Fi needs
Termux:API; without it the script asks. On a router, everyone on the network reaches the station and could
send datagrams in the node's name, so use a router you control.

The MeshCom listener binds the phone's address on the node's subnet when the ingest starts. Turn the hotspot
on (or join the router's Wi-Fi) before `start.sh`; brought up later, `status.sh` says so, and
`restart.sh ingest` picks it up. Should the
hotspot's subnet change (some phones pick a new one after a reboot), run `meshcom-setup.sh` again and
enter the new commands on the node.

Traffic from the node shows on the map at once, and none of it changes a trust tier by itself: a direct
hearing by your own node counts toward Tier A only once you add the node's call to `FIRST_PARTY_SITES`, as
on any ingest box ([MeshCom](../../docs/operate/meshcom.md#how-meshcom-traffic-is-trusted)).

## Visitors over https

A visitor's browser grants location and keeps a sign-in only on a secure origin. `http://localhost` on the
phone is one; `http://<hotspot address>:8787` on a visitor's phone is not. `tls.sh` gives the gateway an https
listener for them:

```bash
bash ~/aprscaching/deploy/pocket/tls.sh                          # once; restarts the gateway
bash ~/aprscaching/deploy/pocket/signin-link.sh --hotspot OE8VIS # per visitor: a link and a QR code
```

- **A CA of the station's own**, made once in `~/.aprscaching/tls` (P-256, the key readable only by
  Termux). It is name-constrained to private and loopback addresses, so a visitor who installs it trusts it
  for nothing on the internet.
- **A certificate for the phone's addresses**: `127.0.0.1`, `localhost` and every private address other
  devices reach (the hotspot, a joined Wi-Fi, tethering; not mobile data), valid 30 days. The hotspot's
  address depends on the phone: some keep it, others pick a new one when the hotspot or the phone restarts.
  When a new address appears, the tmux window `tls` issues the certificate again within 30 s and hands it
  to the running gateway without a restart. `start.sh` renews before the gateway starts, and a certificate
  with less than 7 days left is renewed too.
- **The `.env`** gets `HTTPS_PORT=8443` (`--port` to change), `TLS_CERT`, `TLS_KEY`, `TLS_CA_CERT` and
  `OPERATOR_LINKS_FOR_ANY_CALL=1`. `APP_URL` stays `http://localhost:8787`, so the station on the phone works
  as before. A page load from another device on port 8787 is redirected to https.
- **Visitors** see a certificate warning once and accept it, or first install the CA from
  `http://<hotspot address>:8787/pocket-ca.crt` (Android: Settings → Security → Encryption & credentials →
  Install a certificate → CA certificate; `status.sh` prints its SHA-256 fingerprint to compare). Chrome and
  Brave trust an installed CA; Firefox for Android only with *Use third party CA certificates* in its secret
  settings (Settings → About Firefox, tap the logo seven times).
- **Sign-in** is the per-visitor one-time link: `signin-link.sh --hotspot <CALL>` names
  `https://<hotspot address>:8443` and prints a QR code for the visitor to scan. Passkeys do not work at an IP
  address. The visitor's account starts unverified and logs finds only under the visitor's own call.
- **The opt-in has a cost**: with `OPERATOR_LINKS_FOR_ANY_CALL=1`, `OPERATOR_SECRET` mints a link for any
  account. Keep it to yourself, and run `tls.sh --disable` (which removes the https settings and keeps the
  CA) before the station serves anyone else as an operator.
- **Backups leave the CA out**: its key signs certificates, so it stays on the phone. A station restored
  elsewhere gets a new CA on its first start (`start.sh` renews before the gateway starts), and visitors
  who installed the old one install the new one.

## Reaching the station from the internet

Mobile networks put the phone behind the carrier's NAT (`status.sh` says so for mobile data): nothing on the
internet can open a connection to it. Without the two options below the station is reachable only on its
own hotspot and on a Wi-Fi network the phone has joined. Both are optional and off by default; a Pocket
station is a field and demo station, and exposing it publicly is your decision.

**Cloudflare Tunnel.** `cloudflared` is a Termux package. It opens an outbound connection to Cloudflare, and
a hostname of yours reaches the station through it. It needs a Cloudflare account, a domain on Cloudflare
and a named tunnel created in the dashboard, as in [Docker](../../docs/operate/docker.md#cloudflare-tunnel-ingress-a-pi-or-mini-pc-at-home),
with the public hostname's service set to `http://localhost:8787`. Then:

```bash
pkg install cloudflared
( umask 077; printf '%s
' '<the tunnel token>' > ~/.aprscaching/tunnel.token )
tmux new-window -d -t aprscaching -n tunnel   'TUNNEL_TOKEN="$(cat ~/.aprscaching/tunnel.token)" cloudflared tunnel --no-autoupdate run'
```

In the `.env`, set `APP_URL=https://<your hostname>`, then `restart.sh gateway`. Passkeys and sign-in links
then belong to that hostname, so open the station there on the phone too; this needs a data connection.
Quick tunnels (`cloudflared tunnel --url …`) get a new random name on every run and do not fit `APP_URL`.
Leave `TRUST_CF` unset: the station stays reachable on its hotspot, where a client could send Cloudflare's
client-address header itself. The rate limits then count every visitor through the tunnel as one client.

**WireGuard and 44Net Connect.** A licensed operator gets a fixed 44.x address from ARDC's 44Net Connect,
carried over WireGuard, which works behind the carrier's NAT. Import the Connect configuration into the
WireGuard app (F-Droid or the Play Store). Android runs it as the phone's VPN, so it covers the whole phone,
and the gateway, which listens on every interface, answers on the 44.x address too. Who reaches it there
depends on the tunnel's `AllowedIPs`: 44Net hosts only with a split tunnel, the whole internet with a full
tunnel that also carries every app's traffic. [Pocket on 44Net](../../docs/operate/pocket.md#pocket-on-44net)
has that choice, the exposure, federation and `extras/ampr-cert.sh` for https on the ampr.org name; read
[44Net](../../docs/operate/44net.md) too. **Unverified**: whether Android delivers inbound connections on the VPN
interface to Termux on every phone; test from another network before you rely on it.

## Backup

```bash
termux-setup-storage                                # once: allow Termux to write to shared storage
bash ~/aprscaching/deploy/pocket/backup.sh          # to ~/storage/shared/aprscaching-backups/
```

The snapshot is consistent while the gateway runs (SQLite's online backup, through the better-sqlite3 the
gateway already uses). The archive holds the `.env` and `session.secret`, and shared storage is readable by
any app with storage permission: `--no-env` leaves them out. `--dest DIR`, `--keep N`, `--media` /
`--no-media` (media is included up to 50 MiB by default), and `--restore FILE`, which stops the station,
keeps the current database in `~/.aprscaching/before-restore-<time>/` and starts it again.

The operator guide is [Pocket: a station on an Android phone](../../docs/operate/pocket.md), and
`test/termux-ci.sh` (run weekly by `.github/workflows/pocket-termux.yml`) installs and starts Pocket in the
`termux/termux-docker` image.
