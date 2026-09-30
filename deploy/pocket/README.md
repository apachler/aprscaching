# deploy/pocket/

**Pocket** runs the gateway (`servers/node`, SQLite) and the ingest (`apps/ingest`) on an Android phone
in [Termux](https://termux.dev), without root: a field-day or demo station, not a 24/7 server. Android
stops background apps, and battery and heat are real limits.

| File | Purpose |
|---|---|
| `pocket.sh` | the one-command install: upgrades Termux with `apt-get`, runs `install.sh` from the same branch, starts the station and prints its URLs and a one-time sign-in link; safe to re-run |
| `install.sh` | installs the Termux packages, clones or updates `~/aprscaching`, installs only what the gateway, the ingest and the web build need, compiles better-sqlite3 for Android, builds the web app, writes `~/.aprscaching/.env` on the first run and starts the gateway once to apply the migrations; safe to re-run |
| `.env.pocket.example` | the settings `install.sh` starts from (gateway on port 8787, ingest to localhost) |
| `start.sh` | starts the tmux session `aprscaching` (windows `gateway`, `ingest`, `logs`, `shell`, and `tls` with https on) with a wake lock, or attaches to it; `--no-attach`, `--gateway-only` |
| `stop.sh` | stops the ingest and the gateway (SIGTERM, then SIGKILL after a grace period), closes the session, releases the wake lock |
| `status.sh` | the processes (uptime, restarts), `/health`, the URLs other devices use on each network (the hotspot included, http and https), a warning on a joined Wi-Fi network, the https certificate, storage, database size, battery |
| `update.sh` | runs `install.sh` for the current branch, then restarts both processes; the gateway migrates on start |
| `backup.sh` | database snapshot, `.env` and media to shared storage, keeps the newest 7; `--restore FILE` |
| `signin-link.sh` | a one-time sign-in link for a callsign, for a browser where the passkey does not work; `--hotspot` for a visitor, with a QR code |
| `tls.sh` | https for visitors on the hotspot: a station CA, a certificate for the phone's private addresses, the https settings in the `.env`; `--renew`, `--disable` |
| `supervise.sh`, `lib.sh` | the restart loop `start.sh` runs in each window, and the code the scripts share |
| `boot/start-aprscaching` | optional [Termux:Boot](https://f-droid.org/packages/com.termux.boot/) script: starts the station at boot |
| `test/linux-smoke.sh` | checks `pocket.sh`, recovery, status, backup, `tls.sh` and stop on a Linux box with tmux (not part of CI) |

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

The operator guide is `docs/operate/pocket.md`.
