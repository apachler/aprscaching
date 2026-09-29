# Your first hour as sysop

Your instance boots ([Deployment](deployment.md) · [Running in Docker](docker.md)) — this page walks
the ordered first hour from "it starts" to a public, verified, backed-up instance.

The same checklist lives **in the app**: sign in as an operator and open **Instance admin → Setup**.
It checks every item below live against your instance and tells you what still needs attention.

!!! note "What the Setup wizard writes — and what it never writes"
    Security-critical settings are **environment-only by design**: secrets (`INGEST_SECRET`,
    `OPERATOR_SECRET`, `SESSION_SECRET`, `FED_PRIVATE_KEY`, email/VAPID keys) and the operator list
    (`ADMIN_CALLSIGNS`) can never be changed through the web — a compromised session must not be
    able to rewrite them, and the server never echoes their values, only whether they are set and
    healthy. The wizard shows these **read-only** with a hint where to set them. Everything that is
    safe to manage at runtime — federation peers and trust, forwarding partners and rules — is
    writable through the sysop surfaces (every write is gated server-side).

Where "set the env" appears below, that means your deployment's environment:
`deploy/.env` (Docker), the systemd unit's `EnvironmentFile` (bare metal), or
`npx wrangler secret put` / `--var` (Cloudflare). Restart the gateway after changing it.

## 1. Set the secrets

Three secrets, three jobs — keep them distinct, and give an ingest box only the first:

- `INGEST_SECRET` — the ingest-box credential: packets, the outbox, BBS delivery, the node mirror,
  finds logged over APRS, remote-box polling. The gateway refuses to boot with the `change-me` default.
- `OPERATOR_SECRET` — your scripts' credential for instance-wide configuration (the operator CLI below,
  peer trust, forwarding partners and rules). Leave it unset and those machine paths stay closed; the web
  sysop surface works either way. It must differ from `INGEST_SECRET`.
- `SESSION_SECRET` — signs user sessions; nobody can sign in without it. The Node/Bun servers generate one
  on first start and keep it beside the database when you leave it unset; on Cloudflare set it with
  `npx wrangler secret put SESSION_SECRET`.

`deploy/setup.sh` generates all three for the Docker stack; the desktop app generates them into its data
directory.

## 2. Name yourself operator

Set `ADMIN_CALLSIGNS=OE8APR` (comma-separated for co-sysops), restart, and sign in with that
callsign. The operator role needs the call control-verified — a sign-up under the name alone is not a
sysop, and **Settings → Account** says so. Confirm it with the operator CLI, which uses `OPERATOR_SECRET`
and accepts only a call listed in `ADMIN_CALLSIGNS`:

```bash
BASE=https://api.example.net OPERATOR_SECRET=… node tools/admin/verify-call.mjs OE8APR
```

This needs no receiving site, so it works before step 6. The shield icon then reveals **Instance admin**
(reload the app); its **Setup** group is this checklist, live.
Without `ADMIN_CALLSIGNS` there is no web sysop at all — the admin endpoints stay locked.

## 3. Fix your public identity

- `INSTANCE` — the canonical domain (e.g. `oe.example.net`); it names your records in federation.
- `APP_URL` — the app origin, used for magic-link redirects and credentialed CORS. Without it (or
  `CORS_ORIGINS`) no other origin may send a signed-in user's cookie.
- `RP_ID` — the registrable domain passkeys bind to. **Choose this before users register
  passkeys**; changing it later invalidates them.

## 4. Make email work

Set `EMAIL_FROM` + `EMAIL_API_KEY` (a Resend-style API). Without them the instance fails closed:
sign-in links cannot be delivered and dev tokens stay off. Email is also the mandatory fallback for
notifications where web push is unavailable.

## 5. Verify control of your callsign

Step 2 verified your call. Every other operator verifies theirs over the air: **Settings → Account →
verify** shows a message such as `VERIFY 482913` to send to the service call, and the call is verified
once a site listed in `FIRST_PARTY_SITES` (step 6) hears it on its own radio. Until you attest a site, no
user can verify that way; a sysop can verify an out-of-range operator by hand under **Instance admin →
Callsign verification**. Receiving never needs verification, but every transmit path is gated on it — the
APRS-IS passcode verifies nothing.

## 6. Attest your RF sites (the Tier-A gate)

Set `FIRST_PARTY_SITES` to the IGate/site callsigns **you operate** (e.g. `OE8XBM-10`), and give
each of your ingest boxes the matching `RF_SITE_CALL` (or `IGATE_CALL`). Transport never equals
trust: only frames that a listed site's own ingest box heard directly on its TNC or MeshCom node can
originate a Tier-A find. An APRS-IS line naming the site (`qAR,OE8XBM-10`) never does — APRS-IS passcodes
are public, so anyone can inject one — and an IGate visible to you only on APRS-IS must run the ingest box
for its hearings to count. Without this, no find on your instance reaches Tier A.

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
[Connect a radio: quick starts](quickstarts.md) walks through each link;
[RF ingest & transports](rf-ingest.md) lists every setting.

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
