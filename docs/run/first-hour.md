# Your first hour

This page takes a sysop from "the instance answers" to a working, verified, backed-up instance, in order. It
starts where every install page ends, whatever the shape; at the end your call is confirmed, the instance is
ready to be public, and your RF site is attested.

The same checklist runs live **in the app** under **Instance admin → Setup**. *Blocking* items mean sign-in or
ingest is broken, *Recommended* ones are expected of a public instance, and *Optional* ones stay collapsed.

## Before you start

- **An installed instance that answers `/health`:** [Self-host with Docker](install/self-host-docker.md),
  [on Oracle Cloud](install/oracle-cloud.md), [without Docker](install/self-host-bare-metal.md),
  [Desktop](install/desktop.md) or [Pocket](install/pocket.md).
- **Where your settings live, and how a change takes effect:**

    | Shape | Settings | Apply a change |
    |---|---|---|
    | Self-host with Docker | `deploy/.env` | `docker compose up -d`, from `deploy/` |
    | Self-host without Docker | `/opt/aprscaching/deploy/.env` | `sudo systemctl restart aprscaching-gateway aprscaching-ingest` |
    | Desktop | the environment you start it with | quit the app and start it again |
    | Pocket | `~/.aprscaching/.env` | `bash ~/aprscaching/deploy/pocket/restart.sh` |

## The checklist

1. **Check these values.** The installer for your shape wrote them; confirm each before anyone signs in:
    - `ADMIN_CALLSIGNS` holds your call. It is the operator list, and it is set only here, never at runtime.
    - `APP_URL` is the address people open. `INSTANCE` and `RP_ID` follow its host. Passkeys bind to that
      host, so a later change locks every member's passkey out.
    - `INGEST_SECRET` and `OPERATOR_SECRET` are set and differ, and `SESSION_SECRET` is set or left for the
      gateway to generate ([Secrets and credentials](../reference/secrets.md)).
    - `FED_PRIVATE_KEY` is set, the key the instance signs its feeds with.
    - `RF_SITE_CALL` names the callsign-SSID of an RF receiver you operate, if you have one yet; the gateway
      trusts it under **Instance admin → Trusted receiving stations** (or `FIRST_PARTY_SITES`).

    **Check:** `deploy/aprscaching doctor` reports no failure in its `config` and `gateway` groups.

2. **Sign in as your call.** Your call is in `ADMIN_CALLSIGNS`, so it opens only through your one-time sign-in
   link (or a proof of control), never by an ordinary sign-up: nobody can register it before you. Mint the link
   on the gateway host and open it, as in [Off-grid sign-in](day-to-day/sign-in-links.md#off-grid-sign-in), on
   any instance. Then add a passkey under **Settings → Account** (on https or `localhost`), so you sign in
   without a link next time.

3. **Confirm your call.** Run the operator script for your shape:

    | Shape | Command |
    |---|---|
    | Self-host with Docker, from `deploy/` | `docker compose exec gateway node tools/admin/verify-call.mjs OE8APR` |
    | Self-host without Docker | `sudo -u aprscaching bash -c 'cd /opt/aprscaching && set -a && . deploy/.env && PORT=8080 node tools/admin/verify-call.mjs OE8APR'` |
    | Pocket | `cd ~/aprscaching && set -a && . ~/.aprscaching/.env && set +a && node tools/admin/verify-call.mjs OE8APR` |
    | Desktop, from a checkout | `BASE=<the gateway's URL> OPERATOR_SECRET=<the secret> node tools/admin/verify-call.mjs OE8APR` |

    It uses `OPERATOR_SECRET` and accepts only a call in `ADMIN_CALLSIGNS`. The Desktop app keeps its operator
    secret in `operator.secret` in its data directory. **Settings → Account** shows the command too, and the
    **Admin** entry appears once it has run ([CLI](../reference/cli.md#operator-callsign)).

4. **Clear the Blocking items** under **Instance admin → Setup**. *Ingest feeding* stays blocking until
   packets arrive: check that `INGEST_URL` reaches the gateway and `INGEST_SECRET` matches, or connect a
   radio ([quick starts](radios/quick-starts.md)).

5. **Make it public-ready**, the *Recommended* items:
    - `OPERATOR_NAME`, `OPERATOR_ADDRESS`, `OPERATOR_EMAIL` for `/imprint` and `/privacy`; `OPERATOR_EMAIL` is
      also the contact in `/.well-known/security.txt` unless `SECURITY_CONTACT` names another;
    - mail, so members without a passkey can sign in and recover: `EMAIL_FROM` and an SMTP server or a
      Resend key ([Send mail](day-to-day/mail.md));
    - a scheduled backup ([Backups](day-to-day/backups.md#what-to-back-up));
    - `SOURCE_REPO` pointing at your published fork if you changed the code (AGPL §13).

    [A public instance's duties](compliance/index.md) explains why each one is expected.

    **Check:** the *Operator imprint* item turns green and `/imprint` shows your details. Run
    `deploy/aprscaching backup` once; `doctor` then passes `resources.backup`. With `deploy/backup.sh`, look
    for `backup: wrote …` or `backup: uploaded …`.

6. **Trust your RF site.** The installer names it on both sides. With a second ingest box, trust its
   `RF_SITE_CALL` under **Instance admin → Trusted receiving stations**, or switch on **Trust this station's
   hearings** for an enrolled box (or add the call to `FIRST_PARTY_SITES`). Only frames a trusted site's own
   receiver heard directly reach Tier A ([why](../reference/trust-model.md#transport-is-not-trust)).

    **Check:** your site call shows under **Instance admin → Trusted receiving stations**, and the *Trusted
    receiving stations* item under **Instance admin → Setup** counts it.

7. **Join the network.** Exchange URLs and key fingerprints with the sysops you know, and add each other under
   **Instance admin → Federation → Add peer**: see
   [Join the network](federation/index.md#joining-the-network).

    **Check:** the *Federation peers* item under **Instance admin → Setup** counts your enabled peers.

8. **44Net**, only with a `44net` endpoint in `FED_ENDPOINTS`: run *Check what peers find in DNS* under
   **Instance admin → Setup → 44Net**. **Instance admin → Federation → Publish your callsign identity** shows the
   records to add ([44Net name and identity](networks/44net-identity.md) explains each result).

## After the checklist

Other members verify their calls themselves (**You → Verify callsign**): over the air once your RF site hears
them, by `ampr.org` DNS, or with a LoTW certificate. A sysop can verify an out-of-range member by hand under
**Instance admin → Callsigns** ([Callsign verification](day-to-day/callsign-verification.md)).

Once members join, reports about caches, logs, photos, messages and profiles reach you under **Instance admin →
Reports**, and by email to `OPERATOR_EMAIL` when mail is configured
([Moderation](day-to-day/moderation.md)).

Optional extras: web push (`VAPID_*`), activity spots (`SPOTS_ENABLED=1`), supporter links (`SUPPORT_LINKS`).
The [Configuration reference](../reference/configuration.md) lists every key.

Secrets and the operator list are environment-only, and the Setup page never writes them: a compromised
session must not be able to rewrite them. The server reports only whether each is set and healthy, never its
value. Peers, trust and forwarding partners are managed on the sysop surfaces.

## Next

- [Connect a radio: quick starts](radios/quick-starts.md): get packets flowing into the instance.
- [Join the network](federation/index.md): federate with other instances.
