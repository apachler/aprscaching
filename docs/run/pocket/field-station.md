# Run Pocket in the field

Pocket is installed; this page runs it as a field station, with visitors, a MeshCom node and a USB TNC.

## Run it

```bash
bash ~/aprscaching/deploy/pocket/start.sh      # the tmux session "aprscaching"; Ctrl-b d leaves it running
bash ~/aprscaching/deploy/pocket/status.sh     # processes, addresses, certificate, MeshCom, storage, battery
bash ~/aprscaching/deploy/pocket/restart.sh    # both processes, or: restart.sh gateway | ingest
bash ~/aprscaching/deploy/pocket/stop.sh
bash ~/aprscaching/deploy/pocket/update.sh     # a branch install: pull, install, restart
bash ~/aprscaching/deploy/pocket/sync.sh       # pull from the peers and push to the home hub now
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
**Raw packets** name the `meshcom` port. MeshCom in general is on the [MeshCom](../radios/meshcom.md) page; its trust
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
the bridge when it is unplugged and plugged in again. Set `RF_SITE_CALL` to this station's call and list it
in `FIRST_PARTY_SITES` to make what the TNC hears count toward Tier A
([Receiving site and Tier A](../radios/rf-ingest.md#receiving-site-and-tier-a)).

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
a pocket, able to crash or run flat. Read [Automatic stations on the air](../compliance/on-air-stations.md) first, and enable
the ingest's transmit features (digipeater, IGate, radio replies) deliberately, as on any ingest box.

The bridge is written from the USB CDC-ACM class specification; prior art: [Termux_CDC_ACM](https://github.com/schuhumi/Termux_CDC_ACM)
and pyusb's Termux file-descriptor work ([pyusb#287](https://github.com/pyusb/pyusb/pull/287), not merged, so
the bridge calls libusb through Python's `ctypes` instead).

## Your radio in the browser

The browser on the phone can connect a Bluetooth Low Energy KISS TNC (a Mobilinkd, for instance) through Web
Bluetooth — see [Your radio in the browser](../../shack/my-radio.md). In Brave, enable *Web Bluetooth API* in
`brave://flags` first. What the browser forwards to the station depends on how it signs in:

- **signed (YOURCALL)** forwards only your own station's packets (any SSID of your call); everything else
  your radio hears stays in the browser.
- **secret (self-host)** — paste the station's `INGEST_SECRET` (`grep INGEST_SECRET ~/.aprscaching/.env`)
  with the gateway base URL `http://localhost:8787`: then everything your radio hears is forwarded. The
  secret stays in the page's memory and is asked for again after a reload.

Either way, what the browser forwards is **Tier C** — never evidence for a find. The browser session ends
when the page closes; for a TNC heard around the clock, other routes feed the same station: a MeshCom node,
APRS-IS, or a KISS-over-TCP TNC the ingest connects to ([RF ingest](../radios/rf-ingest.md)).

## Backup

```bash
termux-setup-storage                                  # once: allow Termux to write to shared storage
bash ~/aprscaching/deploy/pocket/backup.sh            # to ~/storage/shared/aprscaching-backups/
```

A consistent snapshot of the database taken while the gateway runs, with the `.env`, `session.secret` and
media; the newest 7 are kept. Shared storage is readable by any app with storage permission: `--no-env`
leaves the secrets out. `backup.sh --restore FILE` puts one back. The station CA stays on the phone; a station
restored elsewhere makes a new one.

## Troubleshooting

| What you see | Why, and what to do |
|---|---|
| A script says an extra "needs the Termux:API app" | The app is missing, from another source than Termux, or never opened. Install it from the same source as Termux, open it once, and `pkg install termux-api`. |
| `termux-*` commands hang | The same: the Termux:API app does not answer. The scripts give up after 8 seconds. |
| No status notification | Android 13 and later ask for the notification permission: grant it to Termux:API in Android's app settings. |
| The shortcuts do not show | Termux:Widget from the same source, its widget on the home screen, then `extras/setup.sh --shortcuts` again. |
| The scheduled backup never runs | It runs only while charging with the battery above 50 %, and needs `termux-setup-storage` once. `status.sh` shows the last backup. |
| No spoken alerts | `POCKET_ALERTS=1` and `POCKET_ALERTS_SPEAK=1` in the `.env`, a restart, and a text-to-speech engine installed in Android. Only messages to the calls in `ADMIN_CALLSIGNS` alert. |
| The battery saver never switches | `POCKET_BATTERY_LOW` is 0, or Termux:API does not answer; `status.sh` shows the saver state. |
| `usb-kiss.sh --list` shows nothing | An OTG adapter, and a TNC that is powered. A TNC on an FTDI, CP210x or CH340 chip is refused by name: only CDC-ACM devices work. |
| `sync-now.sh` refuses to run | The phone is not on a Wi-Fi network, or Termux:API cannot tell: join Wi-Fi, or allow mobile data with `--mobile`. "0 peers" means `FED_PEERS` names no instance. |
| `ampr-cert.sh` gives up waiting for the record | The portal publishes about once an hour. Check the record there, then run it again; Let's Encrypt then asks for a new value. |
| `status.sh` says 44Net is not connected | The WireGuard app's tunnel is off, or carries no address in ARDC's 44Net space. |
| The station stops with the screen off | See [Keep it running](#keep-it-running): battery "Unrestricted" for Termux, the wake lock, and on Android 14 and later *Disable child process restrictions*. |

## Next

- [Pocket extras](extras.md).
