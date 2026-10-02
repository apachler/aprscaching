# The deploy/aprscaching command

This page is for the sysop. It describes `deploy/aprscaching`, the one command that sets up, checks, backs up,
updates and repairs an instance on every [shape](../choose-a-shape.md).

## Before you start

- A checkout of the repository on the machine that runs the instance. On a phone, Pocket's checkout is
  `~/aprscaching`.
- Run every command from the checkout's root directory.

## The commands

```bash
deploy/aprscaching init selfhost             # set up a shape; init <shape> --help lists its options
deploy/aprscaching status                    # is it running, and where
deploy/aprscaching doctor                    # check everything; changes nothing
deploy/aprscaching update                    # update to a newer release
deploy/aprscaching backup                    # write a backup archive
deploy/aprscaching restore <file>            # restore a backup archive into this shape
deploy/aprscaching rotate-secret INGEST_SECRET
deploy/aprscaching net44 setup <conf>        # bring a 44Net tunnel up; also status, check, remove
deploy/aprscaching help
```

The shapes are `selfhost`, `cloudflare`, `ingest-box`, `baremetal`, `pocket` and `desktop`. A command means
the same thing on every shape; what it runs underneath depends on the shape.

## How it knows the shape

`init` records the shape in `deploy/.shape`, together with the settings file it wrote. The other commands act
on that shape. On an installation set up without `init`, they work out the shape from the host:

| The host has | Shape |
|---|---|
| Termux, or `~/.aprscaching/.env` | Pocket |
| the `aprscaching-gateway` systemd unit | bare metal |
| `deploy/.env` with operator settings (`ADMIN_CALLSIGNS`, `APP_URL` or `OPERATOR_SECRET`) | Self-host |
| `deploy/.env` with only the ingest's settings | ingest box |
| a D1 database id in `workers/gateway/wrangler.toml` | Cloudflare split |

`--shape <shape>` overrides both.

## Options

These options work with every command, before or after it:

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
| `status` | health and containers | Worker health | containers | health and units | `pocket/status.sh` | health |
| `doctor` | yes | yes | yes | yes | yes | yes |
| `backup` | portable archive | portable archive (D1 export) | — | portable archive | portable archive | portable archive (needs Node.js) |
| `restore <file>` | yes | yes (D1 at the backup's schema) | — | yes | yes, and Pocket's own archives | yes, with the app closed |
| `update` | with rollback | with rollback (D1 Time Travel) | code only | with rollback | `pocket/update.sh` | how to replace the binary |
| `rotate-secret <name>` | `deploy/.env` | `wrangler secret put` | `deploy/.env` | `<dir>/deploy/.env` | `~/.aprscaching/.env` | — |
| `net44 …` | tunnel, routing, firewall (with `DOCKER-USER`) | — | — | tunnel, routing, firewall | the app's settings; `status`, `check` | the app's settings; `status`, `check` |

A command a shape does not support says so and exits without changing anything. The scripts underneath
(`setup.sh`, `cloudflare/deploy-cf.sh`, the Pocket scripts) also work on their own, with the same options.

Each task has its own page: [Backups and moving](backups.md), [Updates](updates.md),
[44Net address](../networks/44net.md), and [Rotating a secret](../../reference/secrets.md#rotating-a-secret)
for what changes when each secret is replaced.

## Check the installation

`doctor` checks the whole installation and changes nothing: no setting, no file, no service.

```bash
deploy/aprscaching doctor
deploy/aprscaching --json doctor
```

Each check prints `pass`, `warn` or `fail`, grouped by its id: `config`, `gateway`, `setup`, `ingest`,
`network`, `federation`, `net44`, `service`, `pages`, `resources` and `source`. A check that does not pass also
prints a `fix:` line and, where one helps, a `see:` line naming a page of this manual. The last line counts
the passes, warnings and failures. [Troubleshooting](../troubleshooting.md) explains every check, what its
message means and how to fix it.

- **Exit status.** `doctor` exits with `1` when any check failed, and `0` otherwise; warnings do not change it.
  A cron job or a monitor can run it as it is.
- **JSON.** `--json` prints one document:
  `{"shape", "pass", "warn", "fail", "checks": [{"status", "id", "message", "fix", "docs"}]}`.
- **Secrets.** No message and no fix ever contains a secret value. The operator secret is read from the
  settings file or the environment and only sent to the gateway in a header.

How it reaches each shape:

- **Self-host** checks the gateway through this host's Caddy, with the public name pinned to this host. A DNS
  problem then shows as a `network` failure, not as a dead gateway.
- **Cloudflare split.** The Worker's settings are not readable from your machine, so `doctor` checks the
  Worker over the internet. It reads the Setup checklist when `OPERATOR_SECRET` is in the environment.
  `APRSCACHING_API_BASE` and `APRSCACHING_APP_URL` name the Worker's and the app's URLs when `init` did not
  record them.
- **Desktop.** The app's secrets are read from its data directory.

## Settings are checked at start

Every setting has a type in the [configuration schema](../../reference/configuration.md): a whole number, a
number, one of a fixed set of values, a list, JSON, a URL or free text. A value that does not fit stops the
start, so the instance never falls back to a default you did not choose:

- the Node and Bun servers and the ingest box refuse to start;
- the Worker, which has no start to refuse, reports the problem in **Instance admin → Setup**.

The message names the setting and what it expects, never the value. A blank value counts as unset.

`doctor` checks the settings file against the same schema (the `config` group). `deploy/lib/config-keys.tsv` is
the schema's export for shell scripts, and `deploy/lib/config-keys.json` the same for other tools.

## Next

- [Troubleshooting](../troubleshooting.md): every doctor check and its fix.
- [Backups and moving](backups.md): set up the backup `doctor` looks for.
