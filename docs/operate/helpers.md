# Deployment helpers

`deploy/aprscaching` is one command for every [deployment shape](deployment.md). The command names mean the
same thing on every shape; what each one does underneath depends on the shape.

```bash
deploy/aprscaching init selfhost        # set up a shape (its own questions; --help lists its options)
deploy/aprscaching status               # is it running, and where
deploy/aprscaching doctor               # check everything; changes nothing
deploy/aprscaching backup               # back it up
deploy/aprscaching rotate-secret INGEST_SECRET
deploy/aprscaching help
```

`init` records the shape in `deploy/.shape`, together with the settings file it wrote. The other commands
act on that shape. On an installation set up without the helper, they work out the shape from the host:

| The host has | Shape |
|---|---|
| Termux, or `~/.aprscaching/.env` | Pocket |
| the `aprscaching-gateway` systemd unit | bare metal |
| `deploy/.env` with operator settings (`ADMIN_CALLSIGNS`, `APP_URL`, `OPERATOR_SECRET`) | Self-host |
| `deploy/.env` with only the ingest's link | ingest box |
| a D1 database id in `workers/gateway/wrangler.toml` | Cloudflare split |

`--shape <shape>` overrides both.

## Options

| Option | Effect |
|---|---|
| `--non-interactive` | Asks nothing. Every question takes its default; a required value with no default fails and names the flag that supplies it |
| `--yes` | Confirms every change without asking |
| `--json` | Machine-readable output on stdout; progress goes to stderr |
| `--shape <shape>` | Acts on this shape instead of the recorded one |

The output is plain text with no colour codes, so it reads the same in a terminal, a log or a serial console.

## Commands by shape

| Command | Self-host | Cloudflare split | Ingest box | Bare metal | Pocket | Desktop |
|---|---|---|---|---|---|---|
| `init` | `setup.sh` | `cloudflare/deploy-cf.sh`, after a cost warning | enrollment, feeds, radios, start | user, checkout, build, `.env`, units | `pocket/wizard.sh` | how to get the binary |
| `status` | health + containers | Worker health | containers | health + units | `pocket/status.sh` | health |
| `doctor` | yes | yes | yes | yes | yes | yes |
| `backup` | portable archive | portable archive (D1 export) | — | portable archive | portable archive | portable archive (needs Node.js) |
| `restore <file>` | yes | yes (D1 at the backup's schema) | — | yes | yes; Pocket's own archives too | yes, with the app closed |
| `update` | rollback | rollback (D1 Time Travel) | code only | rollback | `pocket/update.sh` | how to replace the binary |
| `rotate-secret <name>` | `deploy/.env` | `wrangler secret put` | `deploy/.env` | `<dir>/deploy/.env` | `~/.aprscaching/.env` | — |

A command a shape does not support says so and exits without changing anything. The existing scripts
(`setup.sh`, `cloudflare/deploy-cf.sh`, the Pocket scripts) keep working on their own, with the same options.

## doctor

```bash
deploy/aprscaching doctor
deploy/aprscaching --json doctor      # one JSON document: {shape, pass, warn, fail, checks: [{status, id, message, fix, docs}]}
```

`doctor` checks the whole installation and changes nothing. Each check is `pass`, `warn` or `fail`. A check
that is not `pass` also prints a one-line fix and, where one helps, a docs page. The exit status is `1` when
any check failed, so a cron job or a monitor can run it. It never prints a secret value.

| Group | What it checks | Shapes |
|---|---|---|
| `config` | the settings file is owner-only; every setting is a known key (a misspelt one is pointed out) with a value of its type; no secret is weak or an example value; a public instance sets what it needs | every shape with a `.env` |
| `gateway` | `/health` answers; the database answers; the migrations match this checkout (`/health` reports the newest applied one); the gateway runs this checkout's commit | every shape with a gateway |
| `setup` | the gateway's own **Instance admin → Setup** checklist, item by item, read with `OPERATOR_SECRET`; a blocking item that is not met fails. On the Cloudflare split it includes the D1 write budget (used, budget, level) | every shape with a gateway |
| `ingest` | the gateway accepts the box's `INGEST_SECRET` (`GET /ingest/check`); APRS-IS and each configured TNC, AGWPE, host-mode and Meshtastic address answers; each MeshCom node named `=CALL` was heard recently and runs firmware 4.35t or newer; `MESHCOM_BIND=0.0.0.0` on a public host | every shape with an ingest |
| `network` | the public name resolves; its TLS certificate is valid (a warning 14 days before it expires); the public URL reaches this gateway (the same instance and commit answer there) | public instances |
| `federation` | the signing key is set; the settings are the safe ones (see [Running federation safely](../guides/federation.md#running-federation-safely)); each peer in `FED_PEERS` answers. A LAN instance has federation off | gateways |
| `service` | Self-host: the containers run, the gateway's port is not published past Caddy, MeshCom's UDP port is not open on every address of a public host. Bare metal: both units run. Ingest box: the container runs | per shape |
| `pages` | the Pages app was built for this Worker (`VITE_API_BASE`) | Cloudflare split |
| `resources` | free space on the data disk; the database's size; the newest backup is at most 7 days old (`APRS_BACKUP_MAX_DAYS`) | every shape |
| `source` | `/.well-known/source` names the repository and commit (AGPL §13); a checkout with local changes sets `SOURCE_REPO` to its fork | gateways |

Self-host checks the gateway through this host's Caddy, with the public name pinned to this host. A
DNS problem then shows as a `network` failure, not as a dead gateway. On the Cloudflare split the Worker's
settings are not readable from your machine: `doctor` checks it over the internet. It reads the Setup checklist
when `OPERATOR_SECRET` is in the environment. `APRSCACHING_API_BASE` and `APRSCACHING_APP_URL` name the
Worker's and the app's URLs when `init` did not record them. The desktop app's secrets are read from its
data directory.

## Backup and restore

```bash
deploy/aprscaching backup                         # one archive: database rows, settings, generated secrets, manifest
deploy/aprscaching backup --with-media --dest /mnt/usb
deploy/aprscaching restore aprscaching-selfhost-20261001T120000Z.tar.gz --dry-run
deploy/aprscaching restore aprscaching-selfhost-20261001T120000Z.tar.gz
```

`backup` writes one portable archive, `aprscaching-<shape>-<UTC time>.tar.gz`, to `--dest`, else `BACKUP_DIR`,
else `deploy/backups`. It holds:

- `rows.sql` — every row of the database as SQL, with the newest migration it had. The rows are read in one
  transaction, so the gateway may keep running.
- `settings.env` — the `.env` (`--no-settings` leaves it out).
- `secrets/` — the secrets the gateway generated beside its database (`session.secret`; on the desktop also
  the ingest and operator secrets).
- `media/` — only with `--with-media`.
- `manifest.json` — the shape, the time, the schema, the commit and the row counts.

The archive holds the instance's secrets, so it is created readable by its owner only. Keep it off shared
folders.

`restore` replaces the instance's data with an archive's:

1. It refuses an archive from a newer schema than this checkout knows: update first.
2. `--dry-run` shows what it would restore and changes nothing.
3. It stops the instance and builds a new database: the migrations up to the archive's schema, then its rows,
   then every newer migration. The old database stays beside it as `before-restore-<time>-*`.
4. It restores the instance settings: identity, secrets, federation, operator. It keeps this host's own:
   `INGEST_URL`, paths, ports, `DOMAIN`, the tunnel token, `TRUST_PROXY`/`TRUST_CF`, and the box's key.
5. It restores the secret files and any media, starts the instance and runs `doctor`.

On the Cloudflare split, `backup` exports D1 with `wrangler d1 export --no-schema`. `restore` needs D1 at the
archive's schema, prints a Time Travel bookmark first, then replaces D1's rows. It sets the archive's secrets
with `wrangler secret put` and lists the plain settings to put in `wrangler.toml`. R2 media is not part of
the archive; see [Backups](deployment.md#backups).

`deploy/backup.sh` stays the scheduled snapshot for cron: it uploads to a bucket. `doctor` counts both kinds
when it checks the age of the newest backup.

### Moving between shapes

Take a backup on the old shape, `init` the new one, then `restore` there. For example, Pocket → Self-host, or
Self-host → bare metal. Keep these the same:

- **`APP_URL`**, and with it `RP_ID`: passkeys are bound to that domain, and a new one locks every member's
  passkey out.
- **The federation signing key**, which moves inside the archive: peers pin it, and a new key breaks their
  trust.

After the move, point the ingest box at the new address, or enroll it again.

## Update

```bash
deploy/aprscaching update                 # to the newest release tag, else the branch's head
deploy/aprscaching update --ref v1.2.0
```

1. It fetches, refuses a checkout with local changes, and shows the current and target versions with the
   commits in between.
2. It runs `doctor` and takes a backup.
3. It moves the checkout to the target and brings the instance onto it:
   - Self-host: rebuild and restart with compose;
   - bare metal: install, build the web app, restart the units;
   - Cloudflare: `cloudflare/publish.sh`;
   - ingest box: rebuild the container.

   The gateway applies new migrations when it starts.
4. It runs `doctor` again. If a check fails that did not fail before the update, it rolls back:
   1. the database to the pre-update backup, held at the backup's schema;
   2. then the code, rebuilt and restarted.

   This happens automatically while the backup is younger than `--rollback-window` (15 minutes). After that
   it asks first, because a database rollback loses what was written since. On the Cloudflare split, the
   database goes back with D1 Time Travel. An ingest box has no database, so only its code rolls back.

A failure that existed before the update does not trigger a rollback. Pocket updates with
`pocket/update.sh`. The desktop app updates by replacing its binary.

## Self-host

`init selfhost` runs `deploy/setup.sh`, so its options work here too (`deploy/aprscaching init selfhost
--help`). A public instance gets the safe federation posture written out and a LAN instance starts with
federation off: see [Running in Docker](docker.md).

## Ingest box

```bash
deploy/aprscaching init ingest-box --gateway https://aprs.example.net --code ABCD-EFGH-JKLM-NPQR --call OE8APR
```

Sets up a box that feeds a gateway elsewhere, in Docker (`compose.ingest-only.yml`):

1. checks that the gateway answers at `<gateway>/ingest/check`;
2. **enrolls the box** with a one-time code from the gateway's **Instance admin → Ingest boxes**
   ([Enrolling ingest boxes](administration.md#enrolling-ingest-boxes)). Enrollment runs inside the ingest
   image, so the box needs no Node.js, and writes `BOX_ID` and `BOX_KEY` into `deploy/.env` without showing
   the key. With `--shared-secret` it takes the gateway's `INGEST_SECRET` instead, asked for without
   echoing it (non-interactive: from the environment);
3. asks for the APRS-IS login and filter, a KISS TNC (`--kiss host[:port]`) and a MeshCom node
   (`--meshcom address=CALL`). With a TNC, it asks for the receiving site the TNC names (`RF_SITE_CALL`),
   which counts for Tier A only once the gateway's sysop lists it in `FIRST_PARTY_SITES`;
4. starts the ingest container and runs `doctor`, which checks the box's credential the way the box sends it:
   signed, for an enrolled box.

It refuses a `deploy/.env` that belongs to a gateway: the Self-host stack runs its own ingest. Re-running it
keeps the enrolled key unless you pass a new `--code`. `--no-start` writes the settings only. A revoked box
shows in `doctor` as refused, with the fix: enroll again with a new code.

## Cloudflare split

`init cloudflare` is kept to the existing one-shot (`deploy/cloudflare/deploy-cf.sh`, which needs `wrangler`
logged in). It first says what the split costs and points to Self-host behind a Cloudflare Tunnel, then
asks before it deploys (`--yes` confirms). It records the Worker's and the app's URLs (`--api-base`,
`--app-url`), so `status` and `doctor` work from the same machine afterwards. Set up the RF box with
`init ingest-box --gateway <the Worker's URL>`.

## Bare metal

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

## Rotating a secret

```bash
deploy/aprscaching rotate-secret INGEST_SECRET
```

This replaces one secret with a fresh random value in the shape's settings, after you confirm. Restart the
instance to apply it. What changes when you rotate:

| Secret | Effect |
|---|---|
| `INGEST_SECRET` | Every ingest box needs the new value before it can post again. The helper shows the value once, so you can copy it to the boxes |
| `OPERATOR_SECRET` | Scripts that send `x-operator-secret` need the new value |
| `SESSION_SECRET` | Every user is signed out |
| `FED_SUBMIT_SECRET`, `FED_RELAY_SECRET` | The hub and every spoke must share the new value |
| `FED_CORROBORATION_SECRET` | Trusted peers that ask for corroboration need the new value |

The federation signing key (`FED_PRIVATE_KEY`) is not rotated this way. Use `tools/fedkey/rotatekey.mjs`,
which signs the new key with the old one so peers keep trusting it.

## Settings are checked at start

Every setting has a type in the [configuration schema](../reference/configuration.md), such as a whole
number, one of a fixed set of values, JSON or a URL. A value that does not fit stops the start, instead of
the instance silently falling back to a default you did not choose:

- the Node and Bun servers and the ingest box refuse to start;
- the Worker, which has no start to refuse, reports the problem in **Instance admin → Setup**.

The message names the setting and what it expects, never the value. A blank value counts as unset.

The helpers check values against the same schema. `deploy/lib/config-keys.tsv` is the schema's export for
shell scripts, and `deploy/lib/config-keys.json` the same for other tools.
