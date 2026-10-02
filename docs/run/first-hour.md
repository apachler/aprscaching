# Your first hour

From "it starts" to a working, verified, backed-up instance, in order. The commands are for the Docker stack
([Self-host with Docker](install/self-host-docker.md)), run from `deploy/`; the [Desktop](install/desktop.md) app generates its
secrets itself, and the [Cloudflare split](install/cloudflare-split.md) takes them as `wrangler secret`s.

The same checklist runs live **in the app** under **Instance admin → Setup**: *Blocking* items mean sign-in or
ingest is broken, *Recommended* ones are expected of a public instance, and *Optional* ones stay collapsed.

## The checklist

1. **Write the configuration.** `./setup.sh` asks for your callsign, the APRS-IS passcode and filter, how
   people reach the box (a public domain, a Cloudflare Tunnel, or the LAN only), and the callsign-SSID of an
   RF receiver you operate. It writes `.env`: `ADMIN_CALLSIGNS`, `APP_URL` (`INSTANCE` and `RP_ID` follow
   its host), `DOMAIN`, the `APRSIS_*` feed, `RF_SITE_CALL` + `FIRST_PARTY_SITES`, and fresh
   `INGEST_SECRET`, `OPERATOR_SECRET` and `FED_PRIVATE_KEY`. `SESSION_SECRET` stays empty: the gateway
   generates it on first start. Re-running it keeps every value you already have.
2. **Start it and check health.** `SOURCE_COMMIT=$(git rev-parse HEAD) docker compose up -d --build`, then `curl -fsS https://<your domain>/health`
   (`http://<LAN address>/health` off-grid). The wizard prints both for your choice.
3. **Sign in as your call.** Open `APP_URL` and create the account with a passkey. Off-grid (plain http, no
   email), use a one-time link instead — see [Off-grid sign-in](day-to-day/sign-in-links.md#off-grid-sign-in).
4. **Confirm your call.**

    ```bash
    docker compose exec gateway node tools/admin/verify-call.mjs OE8APR
    ```

    It uses `OPERATOR_SECRET` and accepts only a call in `ADMIN_CALLSIGNS`. **Settings → Account** shows the
    command too, and the **Admin** entry appears once it has run. From a checkout, set `BASE` and
    `OPERATOR_SECRET` yourself ([CLI](../reference/cli.md#operator-callsign)).
5. **Clear the Blocking items** under **Instance admin → Setup**. *Ingest feeding* stays blocking until
   packets arrive: check that `INGEST_URL` reaches the gateway and `INGEST_SECRET` matches, or connect a
   radio ([quick starts](radios/quick-starts.md)).
6. **Make it public-ready** — the *Recommended* items:
    - `OPERATOR_NAME`, `OPERATOR_ADDRESS`, `OPERATOR_EMAIL` for `/imprint` and `/privacy`;
    - `EMAIL_FROM` + `EMAIL_API_KEY`, so members without a passkey can sign in and recover;
    - a nightly `deploy/backup.sh` cron (on the Cloudflare split: D1 Time Travel plus a copy of the R2 media —
      [Backups](day-to-day/backups.md#what-to-back-up));
    - `SOURCE_REPO` pointing at your published fork if you changed the code (AGPL §13).

    **Check:** the *Operator imprint* item turns green and `/imprint` shows your details; run
    `./backup.sh` once by hand and look for `backup: wrote …` or `backup: uploaded …`.
7. **Attest your RF site.** `setup.sh` names it on both sides; with a second ingest box, add its
   `RF_SITE_CALL` to `FIRST_PARTY_SITES`. Only frames a listed site's own receiver heard directly reach
   Tier A — [why](../reference/trust-model.md#transport-is-not-trust). **Check:** the *First-party RF sites* item under
   **Instance admin → Setup** names your site call.
8. **Join the network.** Add the peers you know to `FED_PEERS` and ask their operators to add yours — see
   [Federation → Joining the network](federation/index.md#joining-the-network). **Check:** the
   *Federation peers* item under **Instance admin → Setup** counts your enabled peers.

9. **44Net** (only with a `44net` endpoint in `FED_ENDPOINTS`). Under **Instance admin → Setup → 44Net**,
   open *Check what peers find in DNS*. It reads the A record of the host peers contact (inside
   44.0.0.0/8), the `_aprscaching.<call>.ampr.org` TXT (it shows the exact value to publish, with `host=`
   when your endpoint is a name under `<call>.ampr.org`), and whether the descriptor lists the same 44net
   endpoint; DNSSEC and any AAAA record are shown as information. Changes in the 44Net Portal publish within
   about an hour. The check reads DNS only: it neither tests reachability nor changes peers or trust.

Other members verify their calls themselves (**You → Verify callsign**): over the air once your RF site
hears them, by `ampr.org` DNS, or with a LoTW certificate. A sysop can verify an out-of-range member by
hand under **Instance admin → Callsign verification**.

Optional extras: web push (`VAPID_*`), activity spots (`SPOTS_ENABLED=1`), supporter links (`SUPPORT_LINKS`).
The [Configuration reference](../reference/configuration.md) lists every key.

!!! note "What the Setup page never writes"
    Secrets and the operator list are environment-only: a compromised session must not be able to rewrite
    them, and the server reports only whether each is set and healthy, never its value. Set them in
    `deploy/.env` (Docker), the systemd unit's `EnvironmentFile`, or `wrangler secret put` (Cloudflare split), and
    restart. Peers, trust and forwarding partners are managed on the sysop surfaces.

## Next

- [Connect a radio: quick starts](radios/quick-starts.md).
- [Join the network](federation/index.md).
