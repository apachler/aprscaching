# Self-host without Docker

Bare metal runs the same gateway and ingest from a checkout under systemd, with no Docker.

```bash
deploy/aprscaching init baremetal --call OE8APR --lan-host 192.168.1.10
deploy/aprscaching init baremetal --dry-run        # print every step, run none
```

It installs the gateway and the ingest from a checkout under systemd, without Docker:

1. checks for Linux with systemd, Node.js 22 or newer, pnpm (or corepack), git and curl;
2. creates the system user `aprscaching` (home `/var/lib/aprscaching`) — **root**;
3. creates `/opt/aprscaching` for that user — **root** — and clones the repository into it as that user;
4. installs the dependencies and builds the web app, as that user;
5. writes `/opt/aprscaching/deploy/.env` with the Self-host questions (`setup.sh`; a domain means your own
   reverse proxy forwards it to the gateway's port), owner-only;
6. installs `aprscaching-gateway` and `aprscaching-ingest` into `/etc/systemd/system`, then enables and starts
   them — **root**. The gateway applies the database migrations when it starts;
7. waits for `/health` and prints how to sign in, verify your call and finish in Instance admin → Setup.

It lists the root steps before it starts and runs only those through `sudo`. It installs the newest `v*` tag,
or `main` while the repository has none; `--ref` picks another. A git checkout is installed without a
signature check, and the helper asks before installing it (`--yes` confirms).

| Option | Default |
|---|---|
| `--dir PATH` | `/opt/aprscaching` |
| `--user NAME` | `aprscaching` |
| `--repo URL` | the upstream repository |
| `--ref REF` | the newest `v*` tag, else `main` |
| `--port PORT` | `8080`; the gateway serves the web app on it |
| `--no-start` | install the units without enabling or starting them |
| `--dry-run` | print every step, run none |

Any other option goes to `setup.sh`. Re-running it updates the checkout to the ref and keeps the `.env`.

## Next

- [Your first hour](../first-hour.md).
