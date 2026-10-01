# Deployment helpers

`deploy/aprscaching` is one command for every [deployment shape](deployment.md). The command names mean the
same thing on every shape; what each one does underneath depends on the shape.

```bash
deploy/aprscaching init selfhost        # set up a shape (its own questions; --help lists its options)
deploy/aprscaching status               # is it running, and where
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
| `init` | `setup.sh` | `cloudflare/deploy-cf.sh` | — | — | `pocket/wizard.sh` | how to get the binary |
| `status` | health + containers | — | containers | — | `pocket/status.sh` | health |
| `backup` | `backup.sh` | — | — | — | `pocket/backup.sh` | — |
| `restore <file>` | — | — | — | — | `pocket/backup.sh --restore` | — |
| `update` | — | — | — | — | `pocket/update.sh` | — |
| `rotate-secret <name>` | `deploy/.env` | `wrangler secret put` | `deploy/.env` | — | `~/.aprscaching/.env` | — |

A command a shape does not support says so and exits without changing anything. The existing scripts
(`setup.sh`, `cloudflare/deploy-cf.sh`, the Pocket scripts) keep working on their own, with the same options.

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
