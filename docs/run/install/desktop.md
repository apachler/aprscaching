# Desktop

This page runs an instance as one program on your own computer, with no Docker and no server. It is for a
sysop who wants to try the platform, run a field day, or operate alone off-grid; at the end the app runs in your
browser.

The Desktop app is one executable per system with the gateway, the web app and the database migrations
inside. It keeps SQLite in your user data directory and generates its own secrets on first start. For a shared,
always-on instance, use [Self-host](self-host-docker.md).

## Before you start

- **Windows (x64), macOS (Apple silicon or Intel) or Linux (x64 or arm64).**
- **`sha256sum` and the GitHub CLI (`gh`)**, signed in, to check the download.
- **Your callsign**, to administer the instance.

## Steps

1. From the project's latest release, download the binary for your system and `SHA256SUMS`:

    | System | File |
    |---|---|
    | Windows | `aprscaching-windows-x64.exe` |
    | macOS, Apple silicon | `aprscaching-macos-arm64` |
    | macOS, Intel | `aprscaching-macos-x64` |
    | Linux | `aprscaching-linux-x64` or `aprscaching-linux-arm64` |

2. Check both, in the directory you downloaded them to
   ([Check a download](verified-downloads.md) explains what each check proves):

    ```bash
    sha256sum -c --ignore-missing SHA256SUMS
    gh attestation verify aprscaching-linux-x64 --repo apachler/aprscaching
    ```

    On Windows, compare `Get-FileHash aprscaching-windows-x64.exe` (PowerShell) with the file's line in
    `SHA256SUMS`, and run the same `gh attestation verify` with the `.exe`.

3. Start it with your callsign as the operator. On Linux and macOS, from the download directory:

    ```bash
    chmod +x aprscaching-linux-x64
    ADMIN_CALLSIGNS=OE8APR APP_URL=http://localhost:8787 ./aprscaching-linux-x64
    ```

    On Windows, in PowerShell:

    ```powershell
    $env:ADMIN_CALLSIGNS = "OE8APR"; $env:APP_URL = "http://localhost:8787"
    .\aprscaching-windows-x64.exe
    ```

    The app reads every setting from its environment, like the other shapes
    ([Configuration](../../reference/configuration.md)). `ADMIN_CALLSIGNS` makes your call the operator;
    `APP_URL` is the address you sign in at, which passkeys need.

4. Open `http://localhost:8787` and sign in there. The app also opens a tab on `http://127.0.0.1:8787` by
   itself; that address is another origin, where a passkey does not match `APP_URL`.

The binaries are not code-signed, so macOS Gatekeeper and Windows SmartScreen warn on first start.
`deploy/aprscaching init desktop` prints these steps as well.

## Check that it worked

- The first line it prints names the version, the address and the data directory, with the number of
  migrations applied.
- `curl -fsS http://127.0.0.1:8787/health` answers.
- `deploy/aprscaching status --shape desktop`, from a clone of the repository, reports it healthy.

## Where the data lives

| System | Data directory |
|---|---|
| Windows | `%APPDATA%\aprscaching` |
| macOS | `~/Library/Application Support/aprscaching` |
| Linux | `~/.local/share/aprscaching` (`$XDG_DATA_HOME/aprscaching`) |

`DATA_DIR` picks another directory. It holds the database (`aprscaching.db`), the media, and the three secrets
the app generates on first start, readable by you only:

| File | Variable | Used by |
|---|---|---|
| `ingest.secret` | `INGEST_SECRET` | an ingest box feeding this app |
| `operator.secret` | `OPERATOR_SECRET` | `tools/admin/verify-call.mjs` and the other operator scripts |
| `session.secret` | `SESSION_SECRET` | signing sign-in sessions; deleting it signs everyone out |

A variable set in the environment wins over its file. Back the secrets up with the database
([Backups](../day-to-day/backups.md)).

## Serve your LAN

The app listens on `127.0.0.1` only, so nothing else on your network reaches it. To serve a phone on the same
Wi-Fi, or an ingest box on a Pi, start it with `HOST=0.0.0.0` (or one LAN address). `PORT` picks the port
(default `8787`). Set `APP_URL` to the address the other devices open, for example
`APP_URL=http://192.168.1.10:8787`.

Plain http on a LAN has no passkeys, so members sign in with a one-time link
([One-time sign-in links](../day-to-day/sign-in-links.md)). An ingest box on the LAN posts to
`INGEST_URL=http://<this computer>:8787/ingest` with the value of `ingest.secret`.

## Off-grid

The app needs no internet: its map is a built-in grid with the caches and stations on it, and it fetches no
map tiles. For hunters' offline packs, set `OFFLINE_TILES_PATH` to an [offline map](offline-map.md). Radio comes
from the browser (Web Serial or Web Bluetooth) or from `apps/ingest` run beside it
([Off-grid and LAN](../networks/off-grid.md)).

## Next

- [Your first hour](../first-hour.md): sign in, confirm your call and finish the setup.
- [Your radio in the browser](../../shack/my-radio.md): connect a USB or Bluetooth TNC.
