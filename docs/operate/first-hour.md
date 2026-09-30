# Your first hour as sysop

From "it starts" to a working, verified, backed-up instance, in order. The commands are for the Docker stack
([Running in Docker](docker.md)), run from `deploy/`; the [Desktop](deployment.md#desktop) app generates its
secrets itself, and the [Cloudflare split](deployment.md#cloudflare-split) takes them as `wrangler secret`s.

The same checklist runs live **in the app** under **Instance admin → Setup**: *Blocking* items mean sign-in or
ingest is broken, *Recommended* ones are expected of a public instance, and *Optional* ones stay collapsed.

## The checklist

1. **Write the configuration.** `./setup.sh` asks for your callsign, the APRS-IS passcode and filter, how
   people reach the box (a public domain, a Cloudflare Tunnel, or the LAN only), and the callsign-SSID of an
   RF receiver you operate. It writes `.env`: `ADMIN_CALLSIGNS`, `APP_URL` (`INSTANCE` and `RP_ID` follow
   its host), `DOMAIN`, the `APRSIS_*` feed, `RF_SITE_CALL` + `FIRST_PARTY_SITES`, and fresh
   `INGEST_SECRET`, `OPERATOR_SECRET` and `FED_PRIVATE_KEY`. `SESSION_SECRET` stays empty: the gateway
   generates it on first start. Re-running it keeps every value you already have.
2. **Start it and check health.** `docker compose up -d --build`, then `curl -fsS https://<your domain>/health`
   (`http://<LAN address>/health` off-grid). The wizard prints both for your choice.
3. **Sign in as your call.** Open `APP_URL` and create the account with a passkey. Off-grid (plain http, no
   email), use a one-time link instead — see [Off-grid sign-in](#off-grid-sign-in).
4. **Confirm your call.**

    ```bash
    docker compose exec gateway node tools/admin/verify-call.mjs OE8APR
    ```

    It uses `OPERATOR_SECRET` and accepts only a call in `ADMIN_CALLSIGNS`. **Settings → Account** shows the
    command too, and the **Admin** entry appears once it has run. From a checkout, set `BASE` and
    `OPERATOR_SECRET` yourself ([CLI](../reference/cli.md#operator-callsign)).
5. **Clear the Blocking items** under **Instance admin → Setup**. *Ingest feeding* stays blocking until
   packets arrive: check that `INGEST_URL` reaches the gateway and `INGEST_SECRET` matches, or connect a
   radio ([quick starts](quickstarts.md)).
6. **Make it public-ready** — the *Recommended* items:
    - `OPERATOR_NAME`, `OPERATOR_ADDRESS`, `OPERATOR_EMAIL` for `/imprint` and `/privacy`;
    - `EMAIL_FROM` + `EMAIL_API_KEY`, so members without a passkey can sign in and recover;
    - a nightly `deploy/backup.sh` cron (on the Cloudflare split: D1 Time Travel plus a copy of the R2 media —
      [Backups](deployment.md#backups));
    - `SOURCE_REPO` pointing at your published fork if you changed the code (AGPL §13).
7. **Attest your RF site.** `setup.sh` names it on both sides; with a second ingest box, add its
   `RF_SITE_CALL` to `FIRST_PARTY_SITES`. Only frames a listed site's own receiver heard directly reach
   Tier A — [why](../concepts.md#transport-is-not-trust).
8. **Join the network.** Add the peers you know to `FED_PEERS` and ask their operators to add yours — see
   [Federation → Joining the network](../guides/federation.md#joining-the-network).

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

## Off-grid sign-in

A box reached over plain http (`APP_URL=http://192.168.1.10`) has no passkeys — browsers allow them only on
https or `localhost` — and usually no email. The operator signs people in with a one-time link:

```bash
docker compose exec gateway node tools/admin/signin-link.mjs OE8APR
```

It prints a link to `APP_URL` that opens a confirm page; **Sign in** there opens a session for the account
holding the call's base call, or creates one, unverified, for a new call. Hand the link to the person it is
for — show it on their screen, send it as a QR code, or type it on their device.

How it is kept safe:

- **Only the operator secret mints a link**, and only on the gateway host (the script reaches it over
  loopback). The ingest secret cannot.
- **Scope.** On an off-grid instance the link serves any call, since it is the only way in. Where passkeys
  (https `APP_URL`) or email work, it serves only `ADMIN_CALLSIGNS` calls, so a leaked operator secret cannot
  open a member's account there.
- **Single use, 15 minutes.** The token is spent on the first confirm and refused after it expires.
- **No login CSRF.** Opening the link signs nobody in; only the confirm page's own form (a same-origin POST)
  spends it, so a page that makes a browser load someone's link cannot sign that browser in.
- **Not a verification.** A link opens an account; it never proves control of a callsign. Transmit stays
  gated on control-verification.
- **The link is a bearer credential** until it is used or expires: whoever opens it first gets the session.
  Over plain http the session cookie travels unencrypted on the LAN, like everything else there.
