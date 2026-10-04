# Self-host with Docker

This page installs the recommended shape: the Docker stack in `deploy/` on a box you own. It is for a sysop
with a Linux box; at the end the instance answers on its address and you continue with
[Your first hour](../first-hour.md).

The stack (`deploy/docker-compose.yml`) runs the gateway, the RF ingest and Caddy on anything that runs Docker:
a Pi at home, a mini-PC, or a cloud VM. Compose builds one image on the box (amd64 or arm64) with the gateway,
the ingest and the built web app inside, so the host needs no Node.js or pnpm.

## Before you start

- **A Linux box** with Docker Engine and the Compose plugin 2.24 or newer: `docker compose version` answers.
  The compose files use its `!reset` tag and optional `env_file` entries.
- **Your callsign and APRS-IS passcode.** The wizard asks for both; a blank passcode runs the feed receive-only.
- **How people reach the box**, one of:
    - **Caddy with TLS:** a DNS name pointing at the box, with ports 80 and 443 reachable from the internet.
      Caddy fetches the certificate from Let's Encrypt.
    - **Cloudflare Tunnel:** no inbound port and no static IP, for home connections and CGNAT. Create the
      tunnel first: [Set up the tunnel](../networks/cloudflare.md#set-up-the-tunnel).
    - **LAN only:** plain http on port 80, no internet needed. Members sign in with a one-time link
      ([Off-grid and LAN](../networks/off-grid.md)).

!!! warning "Open only what the stack needs"
    Caddy publishes 80 and 443 (and 443/UDP for HTTP/3); the gateway's port 8080 stays inside Docker. On a public
    box, let the firewall admit only those and SSH from addresses you trust. Never open the gateway port or an
    ingest port.

## With the helper

From the root of a clone:

```bash
deploy/aprscaching init selfhost
```

It runs the same wizard as the manual steps below, keeps `deploy/.env` readable by its owner only, and records
the shape for the other [helper commands](../day-to-day/helper-command.md). `--net44-config <file>` also brings a
44Net Connect tunnel up afterwards. Then start the stack (step 4 below) and check it with
`deploy/aprscaching doctor`.

## Install by hand

1. Clone the repository. Start a new installation from a checked release where one exists
   ([Check a download](verified-downloads.md)); otherwise:

    ```bash
    git clone https://github.com/apachler/aprscaching
    ```

2. Change into the stack's directory. Every command below runs from `deploy/`.

    ```bash
    cd aprscaching/deploy
    ```

3. Write the configuration:

    ```bash
    ./setup.sh
    ```

    It asks for your callsign, the APRS-IS passcode and filter, how people reach the box, and the
    callsign-SSID of an RF receiver you operate. It writes `.env` with `ADMIN_CALLSIGNS`, `APP_URL`, `DOMAIN`,
    the `APRSIS_*` feed, `RF_SITE_CALL` and `FIRST_PARTY_SITES`, and fresh `INGEST_SECRET`, `OPERATOR_SECRET`
    and `FED_PRIVATE_KEY`. The gateway generates `SESSION_SECRET` on first start. At the end it prints the
    start, health and sign-in commands for your choice.

    A value already in `.env` stays unless you confirm the change, and a secret already set is never
    regenerated, so running it again is safe. For scripts:
    `./setup.sh --non-interactive --call OE8APR --domain aprs.example.net` (`--help` lists every flag). Without
    Node.js 22 on the host, the wizard cannot generate `FED_PRIVATE_KEY`; it prints the command that generates
    it inside the image instead.

    A public instance gets the safe federation settings written out, and a LAN instance starts with federation
    off ([Running federation safely](../federation/index.md#running-federation-safely)).

4. Start the stack. `SOURCE_COMMIT` names the commit the instance's source link shows, since the image cannot
   see `.git`:

    ```bash
    SOURCE_COMMIT=$(git rev-parse HEAD) docker compose up -d --build
    ```

    With a Cloudflare Tunnel, add the tunnel overlay:

    ```bash
    SOURCE_COMMIT=$(git rev-parse HEAD) docker compose -f docker-compose.yml -f compose.home.yml up -d --build
    ```

    The gateway applies the database migrations when it starts. The first build takes a few minutes.

## Check that it worked

1. `docker compose ps` shows the gateway as `healthy`.
2. The health endpoint answers, through Caddy:

    ```bash
    curl -fsS https://<your domain>/health      # LAN only: http://<LAN address>/health
    ```

3. `deploy/aprscaching doctor` (from the root of the clone) checks the rest: DNS, the TLS certificate, the
   services and the settings.

## What runs

| Service | Role | Notes |
|---|---|---|
| `gateway` | Node and SQLite gateway on port 8080 inside the stack | Not published; Caddy proxies to it. The database and cache media (`/data/media`) live in the `data` volume. Health check on `/health`. It refuses to start without `INGEST_SECRET` |
| `ingest` | The APRS-IS feed and any RF transports | Starts once the gateway is healthy. It gets `.env` with the operator secret, the session secret and the federation key blanked: it holds only `INGEST_SECRET` |
| `webdist` | One-shot | Copies the web app built inside the image into the volume Caddy serves |
| `caddy` | TLS, the web app and the reverse proxy | `DOMAIN=:80` serves plain http (LAN, or behind the tunnel); `DOMAIN=<your host>` gets a Let's Encrypt certificate |
| `cloudflared` | The tunnel connector | Only with `compose.home.yml`; Caddy then publishes no port |

What each secret guards is in [Secrets and credentials](../../reference/secrets.md).

Every setting in `deploy/.env` reaches both the gateway and the ingest. The settings from
[Your first hour](../first-hour.md) and every [radio transport](../radios/rf-ingest.md) go there too. Apply a
change with `docker compose up -d`.

Each long-running service restarts unless stopped, and its logs are capped at about 30 MB.

## On Oracle Cloud

The one-click Oracle Cloud stack starts this same stack on a free Always Free VM:
[Self-host on Oracle Cloud](oracle-cloud.md).

## Logs

```bash
docker compose logs -f gateway      # from deploy/; also ingest, caddy, cloudflared
```

## Next

- [Your first hour](../first-hour.md): sign in, confirm your call and make the instance public-ready.
- [Backups and moving](../day-to-day/backups.md): what to back up, and how.
- [Updates](../day-to-day/updates.md): take a new release.
