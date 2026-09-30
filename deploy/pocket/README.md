# deploy/pocket/

**Pocket** runs the gateway (`servers/node`, SQLite) and the ingest (`apps/ingest`) on an Android phone
in [Termux](https://termux.dev), without root: a field-day or demo station, not a 24/7 server. Android
stops background apps, and battery and heat are real limits.

| File | Purpose |
|---|---|
| `pocket.sh` | the one-command install: upgrades Termux with `apt`, runs `install.sh` from the same branch, starts the station and prints its URLs and a one-time sign-in link; safe to re-run |
| `install.sh` | installs the Termux packages, clones or updates `~/aprscaching`, installs only what the gateway, the ingest and the web build need, compiles better-sqlite3 for Android, builds the web app, writes `~/.aprscaching/.env` on the first run and starts the gateway once to apply the migrations; safe to re-run |
| `.env.pocket.example` | the settings `install.sh` starts from (gateway on port 8787, ingest to localhost) |
| `start.sh` | starts the tmux session `aprscaching` (windows `gateway`, `ingest`, `logs`, `shell`) with a wake lock, or attaches to it; `--no-attach`, `--gateway-only` |
| `stop.sh` | stops the ingest and the gateway (SIGTERM, then SIGKILL after a grace period), closes the session, releases the wake lock |
| `status.sh` | the processes (uptime, restarts), `/health`, the URL other devices use on each network (the hotspot included), a warning on a joined Wi-Fi network, storage, database size, battery |
| `update.sh` | runs `install.sh` for the current branch, then restarts both processes; the gateway migrates on start |
| `backup.sh` | database snapshot, `.env` and media to shared storage, keeps the newest 7; `--restore FILE` |
| `signin-link.sh` | a one-time sign-in link for a callsign, for a browser where the passkey does not work |
| `supervise.sh`, `lib.sh` | the restart loop `start.sh` runs in each window, and the code the scripts share |
| `boot/start-aprscaching` | optional [Termux:Boot](https://f-droid.org/packages/com.termux.boot/) script: starts the station at boot |
| `test/linux-smoke.sh` | checks `pocket.sh`, recovery, status, backup and stop on a Linux box with tmux (not part of CI) |

Every script takes `--help`, and `--dir` / `--data-dir` (or `APRSCACHING_DIR` / `APRSCACHING_DATA`) when the
checkout or the data are not in `~/aprscaching` and `~/.aprscaching`.

## Install

Use Termux from [F-Droid](https://f-droid.org/packages/com.termux/) or its
[GitHub releases](https://github.com/termux/termux-app/releases), then in Termux, one command:

```bash
curl -fsSL https://raw.githubusercontent.com/apachler/aprscaching/main/deploy/pocket/pocket.sh | bash -s -- --call <YOURCALL>
```

`pocket.sh` upgrades Termux (`apt update && apt full-upgrade`, after `termux-change-repo` when no mirror is
chosen yet and a terminal is attached), runs `install.sh` from the same branch with the options passed on, starts the station and
prints its URLs (on the phone and on the hotspot) and a one-time sign-in link. The link is the way in where
a passkey does not work, e.g. in Firefox or on a phone without Google services. Running it again upgrades,
updates and restarts the station; `bash pocket.sh --help` lists the options (`--branch`,
`--gateway-only`, `--no-start`, and every `install.sh` option).

It upgrades with `apt`, not `pkg`: `pkg` itself runs `curl`, and a half-upgraded Termux (a new `curl`
against an older OpenSSL) stops `curl` with `cannot locate symbol "SSL_…"` until the upgrade completes.
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
optimisation, and on Android 14 and later consider *Disable child process restrictions* in the developer
options (the phantom process killer).

To start the station at boot, install Termux:Boot from F-Droid, open it once, then:

```bash
mkdir -p ~/.termux/boot
cp ~/aprscaching/deploy/pocket/boot/start-aprscaching ~/.termux/boot/
chmod +x ~/.termux/boot/start-aprscaching
```

It waits 30 s after boot (`APRSCACHING_BOOT_DELAY`), then runs `start.sh --no-attach`; its output is in
`~/.aprscaching/logs/boot.log`. Delete the copy to stop starting at boot.

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
