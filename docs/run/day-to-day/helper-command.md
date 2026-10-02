# The deploy/aprscaching command

`deploy/aprscaching` is one command for every [deployment shape](../index.md). The command names mean the
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
| `net44 …` | tunnel, routing, firewall (incl. `DOCKER-USER`) | — | — | tunnel, routing, firewall | the app's settings; `status`, `check` | the app's settings; `status`, `check` |

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
| `federation` | the signing key is set; the settings are the safe ones (see [Running federation safely](../federation/index.md#running-federation-safely)); each peer in `FED_PEERS` answers. A LAN instance has federation off | gateways |
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

## Settings are checked at start

Every setting has a type in the [configuration schema](../../reference/configuration.md), such as a whole
number, one of a fixed set of values, JSON or a URL. A value that does not fit stops the start, instead of
the instance silently falling back to a default you did not choose:

- the Node and Bun servers and the ingest box refuse to start;
- the Worker, which has no start to refuse, reports the problem in **Instance admin → Setup**.

The message names the setting and what it expects, never the value. A blank value counts as unset.

The helpers check values against the same schema. `deploy/lib/config-keys.tsv` is the schema's export for
shell scripts, and `deploy/lib/config-keys.json` the same for other tools.

## Next

- [Backups and moving](backups.md).
