# Your first hour as sysop

Your instance boots ([Deployment](deployment.md) · [Running in Docker](docker.md)) — this page walks
the ordered first hour from "it starts" to a public, verified, backed-up instance.

The same checklist lives **in the app**: sign in as an operator and open **Instance admin → Setup**.
It checks every item below live against your instance and tells you what still needs attention.

!!! note "What the Setup wizard writes — and what it never writes"
    Security-critical settings are **environment-only by design**: secrets (`INGEST_SECRET`,
    `SESSION_SECRET`, `FED_PRIVATE_KEY`, email/VAPID keys) and the operator list
    (`ADMIN_CALLSIGNS`) can never be changed through the web — a compromised session must not be
    able to rewrite them, and the server never echoes their values, only whether they are set and
    healthy. The wizard shows these **read-only** with a hint where to set them. Everything that is
    safe to manage at runtime — federation peers and trust, forwarding partners and rules — is
    writable through the sysop surfaces (every write is gated server-side).

Where "set the env" appears below, that means your deployment's environment:
`deploy/.env` (Docker), the systemd unit's `EnvironmentFile` (bare metal), or
`npx wrangler secret put` / `--var` (Cloudflare). Restart the gateway after changing it.

## 1. Set the secrets

- `INGEST_SECRET` — the ingest-box credential. The gateway refuses to boot with the `change-me`
  default; `deploy/setup.sh` generates a strong one for the Docker stack.
- `SESSION_SECRET` — optional on a single-operator box (sessions derive from `INGEST_SECRET`), but
  a shared gateway sets a dedicated one so the machine credential and user sessions stay separate.

## 2. Name yourself operator

Set `ADMIN_CALLSIGNS=OE8APR` (comma-separated for co-sysops), restart, and sign in with that
callsign. The shield icon reveals **Instance admin**; its **Setup** group is this checklist, live.
Without `ADMIN_CALLSIGNS` there is no web sysop at all — the admin endpoints stay locked.

## 3. Fix your public identity

- `INSTANCE` — the canonical domain (e.g. `oe.example.net`); it names your records in federation.
- `APP_URL` — the app origin, used for magic-link redirects and credentialed CORS.
- `RP_ID` — the registrable domain passkeys bind to. **Choose this before users register
  passkeys**; changing it later invalidates them.

## 4. Make email work

Set `EMAIL_FROM` + `EMAIL_API_KEY` (a Resend-style API). Without them the instance fails closed:
sign-in links cannot be delivered and dev tokens stay off. Email is also the mandatory fallback for
notifications where web push is unavailable.

## 5. Verify control of your callsign

In **Settings → account**, verify your callsign over the air (an APRS message challenge). Receiving
never needs it, but every transmit path is gated on control-verification — the APRS-IS passcode
verifies nothing.

## 6. Attest your RF sites (the Tier-A gate)

Set `FIRST_PARTY_SITES` to the IGate/site callsigns **you operate** (e.g. `OE8XBM-10`). Transport
never equals trust: only packets arriving through a first-party attested site can originate a
Tier-A find. Without this, no find on your instance reaches Tier A.

## 7. Publish the legal pages

Set `OPERATOR_NAME`, `OPERATOR_ADDRESS`, `OPERATOR_EMAIL`. `/imprint` and `/privacy` render them —
and show a loud not-configured warning until you do. A public instance in most of Europe needs
this.

## 8. Sign your feeds and join federation

```bash
node tools/fedkey/genkey.mjs     # prints FED_PRIVATE_KEY (+ the public key it publishes)
```

Set it (as a secret) together with `INSTANCE`. Unsigned feeds still serve, but peers won't mirror
them. Then add peers under **Instance admin → Federation** — by URL or, verified, by callsign over
44net. See [Federation](../guides/federation.md).

## 9. Check the data is flowing

The Setup checklist shows packets heard in the last hour. Silent? Check the ingest box
(`INGEST_URL` points at this gateway, `INGEST_SECRET` matches) or use the browser RF bridge.
[RF ingest & transports](rf-ingest.md) covers every transport.

## 10. Back up the database

Positions are TTL'd; caches, finds, accounts, and keys are the permanent record. Cron
`deploy/backup.sh` (SQLite, uploads to a bucket) or `wrangler d1 export` (D1). Backing up is a
required obligation of running a public instance, same as the next item.

## 11. Expose your source (AGPL §13)

Every instance serves `/.well-known/source` and shows a Source link. If you run modified code, set
`SOURCE_REPO` to your published fork — the upstream default is only honest for an unmodified
checkout.

## 12. Optional polish

- **Web push**: generate VAPID keys and set `VAPID_PUBLIC` / `VAPID_PRIVATE` / `VAPID_SUBJECT`
  (push falls back to the email digest without them).
- **Supporter links**: `SUPPORT_*` env — recognition only, never feature-gating.
- **Spots**: `SPOTS_ENABLED=1` for POTA/SOTA activity on the map.

The [Configuration reference](../reference/configuration.md) documents every key.
