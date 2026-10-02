# Run Pocket in the field

This page shows the sysop how to run an installed Pocket station as a field station. At the end the phone keeps
running with the screen off, serves visitors on its hotspot over https, and logs what a MeshCom node or a USB TNC
hears.

## Before you start

- Pocket is installed on the phone ([Install Pocket on an Android phone](../install/pocket.md)).
- **Termux:API** from the same source as Termux, for the battery, Wi-Fi and USB features
  ([Pocket extras](extras.md)).

Every command here runs in Termux, from any directory.

## Run it

| Command | What it does |
|---|---|
| `bash ~/aprscaching/deploy/pocket/start.sh` | Starts the tmux session `aprscaching`, or attaches to it. `Ctrl-b d` leaves it running. |
| `bash ~/aprscaching/deploy/pocket/status.sh` | Shows the processes, addresses, certificate, MeshCom, storage and battery. Changes nothing. |
| `bash ~/aprscaching/deploy/pocket/restart.sh` | Restarts both processes, or one: `restart.sh gateway` or `restart.sh ingest`. |
| `bash ~/aprscaching/deploy/pocket/stop.sh` | Stops the ingest, then the gateway, and releases the wake lock. |
| `bash ~/aprscaching/deploy/pocket/sync.sh` | Pulls from the peers and pushes to the home hub now ([Before a trip](trips.md)). |

Each script takes `--help`. Updating is on [Updates](../day-to-day/updates.md).

The gateway and the ingest each run in a restart loop: 5 s after an exit, doubling up to 30 s on quick repeated
failures. They read `~/.aprscaching/.env` before every start, so an edited `.env` takes effect on the next
restart. Their logs are in `~/.aprscaching/logs/`, rotated by size.

**Sign in.** Open `http://localhost:8787` in a browser on the phone and sign in with a passkey. On a phone without
Google Play services (microG), passkeys work only on https origins, so mint a one-time link instead:

```bash
bash ~/aprscaching/deploy/pocket/signin-link.sh <YOURCALL>
```

The link is single-use and expires after 15 minutes ([One-time sign-in links](../day-to-day/sign-in-links.md)).

## Keep it running

Android stops background work. On the tested phone, these were enough for the station to run with the screen
off:

- **Wake lock.** `start.sh` takes one (`termux-wake-lock`); `stop.sh` releases it.
- **Battery.** Set Settings → Apps → Termux → Battery → **Unrestricted**.
- **Child processes.** Where Android still kills the processes (`status.sh` shows the restarts climbing), turn on
  **Disable child process restrictions** in the developer options (Android 14 and later). It switches off
  Android's limit on processes an app starts in the background, the phantom process killer.
- **Start at boot.** Install **Termux:Boot** from the same source as Termux, open it once, and copy
  `~/aprscaching/deploy/pocket/boot/start-aprscaching` to `~/.termux/boot/`.
- **Heat.** The gateway, a hotspot and mobile data together warm the phone. Keep it out of direct sun, and on a
  charger for long sessions.

## Visitors over HTTPS

A visitor's browser grants location and keeps a sign-in only on a secure origin. `http://localhost` is one on
the phone itself; `http://<hotspot address>:8787` is not. Turn on https, then mint a link per visitor:

```bash
bash ~/aprscaching/deploy/pocket/tls.sh                                # https on port 8443; restarts the gateway
bash ~/aprscaching/deploy/pocket/signin-link.sh --hotspot <THEIR CALL> # a link and a QR code for the visitor
```

- **The certificate.** `tls.sh` makes a CA of the station's own once, in `~/.aprscaching/tls`. The station
  certificate names `localhost` and the phone's private addresses (hotspot, joined Wi-Fi, tethering). It is valid
  30 days and is issued again when a new address appears or 7 days remain. The tmux window `tls` checks every
  30 s and hands the new certificate to the running gateway without a restart.
- **The visitor's browser** warns until the visitor accepts the certificate once, or installs the CA from
  `http://<hotspot address>:8787/pocket-ca.crt`. `status.sh` prints its fingerprint. Chrome and Brave trust an
  installed CA; Firefox for Android only with *Use third party CA certificates* in its secret settings.
- **Several private addresses.** `signin-link.sh --hotspot --ip <address>` names the one the visitor uses.
- **Turn it off** with `tls.sh --disable` before anyone else operates the station. The CA stays for next time.

`tls.sh` sets `OPERATOR_LINKS_FOR_ANY_CALL=1`, so your link can sign in any call. What that allows, and why a
visitor's account changes no trust, is on [Visitors on the hotspot](../day-to-day/sign-in-links.md#visitors-on-the-hotspot).

## A MeshCom node

A MeshCom node sends everything it handles to the ingest over ExtUDP. It joins the phone's **hotspot** (off grid,
flight mode is fine) or the **router** the phone has joined.

1. Bring the hotspot or the Wi-Fi up.
2. Run the setup script:

    ```bash
    bash ~/aprscaching/deploy/pocket/meshcom-setup.sh
    ```

    It finds the network, and asks when both the hotspot and a Wi-Fi are up (`--hotspot` or `--wifi` answers).
    It prints the commands to enter on the node, writes `MESHCOM_NODE` and restarts the ingest. It never sends
    anything to the node.
3. Enter the printed commands on the node: on its serial console, in the MeshCom app or on its web page.
    - **On the hotspot** the node gets a fixed address high in the hotspot's subnet (`--setownip`,
      `--setowngw`, `--setownms`, then `--extudpip <the phone>` and `--extudp on`).
    - **On a router** the router hands out the addresses. Reserve one for the node and one for the phone in its
      DHCP settings; the script prints only `--setssid`, `--setpwd`, `--extudpip` and `--extudp on`.

The node needs MeshCom firmware 4.35t built on or after 2026-09-25, or newer. The listener binds the phone's
address on the node's network when the ingest starts: bring the network up first, or run `restart.sh ingest`
afterwards (`status.sh` says when). If the hotspot's subnet changes after a reboot, run the script again and enter
the new commands.

To check the data flow:

- `grep -F '[meshcom]' ~/.aprscaching/logs/ingest.log` shows the listener and, every 10 minutes, a counters line.
- `curl -s http://127.0.0.1:8787/api/ports` counts `meshcom` packets.
- On the map, turn on **Search & filter → Live stations**. The node appears after its next beacon, and its page's
  **Raw packets** name the `meshcom` port.

The trust rules of [MeshCom](../radios/meshcom.md#how-meshcom-traffic-is-trusted) hold unchanged. The scripts
never add the node's call to `FIRST_PARTY_SITES`.

## A USB TNC on the phone

A KISS TNC on the phone's USB-C port, through an OTG adapter, feeds the ingest directly. The phone then logs
**every** station the TNC hears, off grid. `extras/usb_kiss_bridge.py` drives the TNC as a CDC-ACM serial port
through libusb and serves KISS over TCP on `127.0.0.1:8001`, where the ingest connects. Android gives USB access
per app, so `termux-usb` (Termux:API) hands the bridge the device.

1. Install the packages:

    ```bash
    pkg install termux-api python libusb
    ```

2. Plug in the TNC and list what Android sees:

    ```bash
    bash ~/aprscaching/deploy/pocket/extras/usb-kiss.sh --list
    ```

3. Set it up. Android asks once for permission to use the device:

    ```bash
    bash ~/aprscaching/deploy/pocket/extras/usb-kiss.sh --setup --baud 9600
    ```

    `--setup` writes `USB_KISS_DEVICE`, `USB_KISS_BAUD`, `KISS_TNC_HOST=127.0.0.1` and `KISS_TNC_PORT` to the
    `.env` and restarts the station. `start.sh` then runs the bridge in the tmux window `usb-kiss`. It waits for
    the TNC and restarts the bridge when the TNC is unplugged and plugged in again.
4. **Optional:** to make what the TNC hears count toward Tier A, set `RF_SITE_CALL` to this station's call and
   list it in `FIRST_PARTY_SITES` ([Receiving site and Tier A](../radios/rf-ingest.md#receiving-site-and-tier-a)).

**Only CDC-ACM devices work**, since they need no driver of their own. The bridge refuses FTDI, Silicon Labs
CP210x, WCH CH340 and Prolific PL2303 chips by name.

| TNC | USB | Status |
|---|---|---|
| A TNC or radio with a native USB CDC-ACM port (for example a KISS TNC on an ESP32-S3 or RP2040) | CDC-ACM | untested |
| TNCs on an FTDI, CP210x, CH340 or PL2303 USB-serial chip | vendor-specific | incompatible (refused by name) |

Only owner-tested entries are marked tested; report yours with the `status.sh` output.

**Receive-only by default.** The bridge drops everything the ingest would send toward the radio. It passes KISS
data frames only when all three hold:

- `USB_KISS_TX=1` in the `.env`;
- your callsign is control-verified on this station;
- `usb-kiss.sh` started the bridge (it checks both).

A watchdog then allows 6 frames a minute, 3 in a burst, each at most 330 bytes, and never the KISS "exit"
command. `status.sh` and the station notification show "TX ON".

!!! warning "The phone becomes an automatic station"
    With transmit on, the phone is an automatic station under your licence: often unattended, in a pocket, able
    to crash or run flat. Read [Automatic stations on the air](../compliance/on-air-stations.md) first, and turn
    on the ingest's transmit features (digipeater, IGate, radio replies) deliberately, as on any ingest box.

## Your radio in the browser

The browser on the phone can connect a Bluetooth Low Energy KISS TNC, such as a Mobilinkd, through Web Bluetooth
([Your radio in the browser](../../shack/my-radio.md)). In Brave, enable *Web Bluetooth API* in `brave://flags`
first. To forward everything the radio hears, choose **secret (self-host)** with the gateway base URL
`http://localhost:8787` and the station's ingest secret: `grep INGEST_SECRET ~/.aprscaching/.env`.

## Backup

`backup.sh` writes an archive to the phone's shared storage, and `extras/setup.sh --scheduled-backup` runs it
daily while the phone charges. [Backups: Pocket](../day-to-day/backups.md#pocket) has the commands and the
restore.

## Troubleshooting

| What you see | Why, and what to do |
|---|---|
| A script says an extra "needs the Termux:API app" | The app is missing, from another source than Termux, or never opened. Install it from the same source as Termux, open it once, and `pkg install termux-api`. |
| `termux-*` commands hang | The Termux:API app does not answer, for the same reasons. The scripts give up after 8 seconds. |
| No status notification | Android 13 and later ask for the notification permission: grant it to Termux:API in Android's app settings. |
| The shortcuts do not show | Install Termux:Widget from the same source, put its widget on the home screen, then run `extras/setup.sh --shortcuts` again. |
| The scheduled backup never runs | It runs only while charging with the battery above 50 %, and needs `termux-setup-storage` once. `status.sh` shows the last backup. |
| No spoken alerts | Set `POCKET_ALERTS=1` and `POCKET_ALERTS_SPEAK=1` in the `.env`, restart, and install a text-to-speech engine in Android. Only messages to the calls in `ADMIN_CALLSIGNS` alert. |
| The battery saver never switches | `POCKET_BATTERY_LOW` is 0, or Termux:API does not answer. `status.sh` shows the saver state. |
| `usb-kiss.sh --list` shows nothing | Check the OTG adapter, and that the TNC has power. A TNC on an FTDI, CP210x, CH340 or PL2303 chip is refused by name: only CDC-ACM devices work. |
| `sync-now.sh` refuses to run | The phone is not on a Wi-Fi network, or Termux:API cannot tell. Join Wi-Fi, or allow mobile data with `--mobile`. "0 peers" means `FED_PEERS` names no instance. |
| `ampr-cert.sh` gives up waiting for the record | The portal publishes about once an hour. Check the record there, then run it again; Let's Encrypt then asks for a new value. |
| `status.sh` says 44Net is not connected | The WireGuard app's tunnel is off, or carries no address in ARDC's 44Net space. |
| The MeshCom node is not heard | The listener started before the network was up. Run `restart.sh ingest`; `status.sh` says when it is needed. More on [MeshCom troubleshooting](../radios/meshcom.md#troubleshooting). |
| The station stops with the screen off | See [Keep it running](#keep-it-running): battery **Unrestricted** for Termux, the wake lock, and on Android 14 and later *Disable child process restrictions*. |

## Next

- [Pocket extras](extras.md): the notification, shortcuts, battery saver and field alerts.
- [Before a trip: sync and your home hub](trips.md): fill the map before you lose signal.
