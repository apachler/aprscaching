# Self-host without Docker

This page installs the gateway and the RF ingest from a checkout under systemd, with no Docker. It is for a
sysop who runs a Linux server with their own reverse proxy; at the end both services run and the gateway
answers on its port.

The gateway serves the web app itself on one port. There is no Caddy: for a public instance, your own reverse
proxy terminates TLS and forwards the whole site to that port.

## Before you start

- **Linux with systemd**, Node.js 22 or newer, pnpm or corepack (Node.js ships corepack), git and curl.
- **sudo**, or a root shell. Four steps need root; the rest runs as a dedicated system user.
- **The GitHub CLI (`gh`)**, signed in, to check the release's signature ([Check a download](verified-downloads.md)).
- **Your callsign and APRS-IS passcode.**
- **How people reach the box:** a public name your reverse proxy serves with TLS, or the LAN only
  ([Off-grid and LAN](../networks/off-grid.md)).
- **A clone of the repository** to run the helper from. The helper installs its own checkout.

## Steps

1. Preview what the helper does. Run it from the root of the clone; `--dry-run` prints every step and runs none:

    ```bash
    deploy/aprscaching init baremetal --dry-run
    ```

2. Install. For a LAN instance, name the address other devices reach the box at; for a public one, pass
   `--domain` instead:

    ```bash
    deploy/aprscaching init baremetal --call OE8APR --lan-host 192.168.1.10
    deploy/aprscaching init baremetal --call OE8APR --domain aprs.example.net
    ```

    It lists the root steps first, then asks before it installs (`--yes` confirms). It then:

    1. checks the requirements above;
    2. creates the system user `aprscaching` (home `/var/lib/aprscaching`), as **root**;
    3. creates `/opt/aprscaching` for that user, as **root**, and fills it with the checkout, as that user;
    4. installs the dependencies and builds the web app, as that user;
    5. writes `/opt/aprscaching/deploy/.env` with the Self-host questions (`setup.sh`), readable by its owner
       only, and points `INGEST_URL` at the gateway on this host;
    6. installs `aprscaching-gateway` and `aprscaching-ingest` into `/etc/systemd/system` from
       `deploy/systemd/`, then enables and starts them, as **root**;
    7. waits up to a minute for `/health` and prints how to sign in and confirm your call.

3. For a public instance, point your reverse proxy at the gateway: forward `https://<your domain>` to
   `http://127.0.0.1:8080`.

The gateway applies the database migrations when it starts. The database and media live in
`/opt/aprscaching/data`.

## What it installs

The helper installs the newest `v*` release tag, or `main` while the repository has none. For a release tag it
downloads the release's git bundle and `SHA256SUMS`, checks both, and clones from the bundle; it stops, having
installed nothing, when a check fails. Without the GitHub CLI it stops too, unless `--checksum-only` accepts the
checksum alone. A branch, or a release without a bundle, is installed from git without a check, and the helper
says so before it asks.

| Option | Default |
|---|---|
| `--dir PATH` | `/opt/aprscaching` |
| `--user NAME` | `aprscaching` |
| `--repo URL` | the upstream repository |
| `--ref REF` | the newest `v*` tag, else `main` |
| `--port PORT` | `8080`; the gateway serves the web app on it |
| `--no-start` | install the units without enabling or starting them |
| `--checksum-only` | accept a release checked by its checksum alone, when `gh` is not installed |
| `--net44-config FILE` | bring a 44Net Connect tunnel up afterwards |
| `--dry-run` | print every step, run none |

Any other option goes to `setup.sh` (`--call`, `--passcode`, `--filter`, `--domain`, `--lan-host`, `--fed-peers`,
…). Running `init baremetal` again moves the checkout to the ref and keeps the `.env`.

## Check that it worked

```bash
curl -fsS http://127.0.0.1:8080/health
systemctl status aprscaching-gateway aprscaching-ingest
deploy/aprscaching doctor          # from the root of the clone
```

If the gateway does not answer, read its log: `journalctl -u aprscaching-gateway -n 50`.

## Next

- [Your first hour](../first-hour.md): sign in, confirm your call and make the instance public-ready.
- [Updates](../day-to-day/updates.md): `deploy/aprscaching update` rebuilds and restarts the units.
