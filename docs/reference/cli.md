# Command-line tools

Helper scripts under `deploy/` install and maintain an instance; those under `tools/` confirm the operator's
callsign and support key management, signing, and verification.

## Instance operation — `deploy/`

```bash
cd deploy && ./setup.sh                  # first-run wizard: writes .env (operator call, APP_URL, APRS-IS feed, site call, INGEST_SECRET, OPERATOR_SECRET, FED_PRIVATE_KEY)
deploy/setup.sh --non-interactive --call OE8APR --domain aprs.example.net   # the same from flags (--help lists them)
deploy/aprscaching init <shape>          # set up any shape, then status, doctor, update, backup, restore, rotate-secret, net44 (see Deployment helpers)
deploy/backup.sh                         # SQLite snapshot, uploaded to BACKUP_DIR / OCI_BUCKET / BACKUP_BUCKET — run nightly from cron
deploy/cloudflare/deploy-cf.sh           # one-shot Cloudflare core (Worker + D1 + R2 + Pages); needs wrangler + Cloudflare login
deploy/cloudflare/cache-rules.sh         # Cloudflare cache rules for a CDN in front of a VM; needs CF_API_TOKEN + CF_ZONE_ID
```

See [Is running an instance for me?](../run/index.md), [The deploy/aprscaching command](../run/day-to-day/helper-command.md) and
[Self-host with Docker](../run/install/self-host-docker.md).

`setup.sh` keeps every value already in `.env` unless you confirm the change (or pass `--yes`), and never
regenerates a secret that is set.

### `deploy/aprscaching` {#deploy-aprscaching}

One command for every shape ([The deploy/aprscaching command](../run/day-to-day/helper-command.md)). Every command takes these options:

| Option | Effect |
|---|---|
| `--shape SHAPE` | act on `selfhost`, `cloudflare`, `ingest-box`, `baremetal`, `pocket` or `desktop` instead of the recorded shape |
| `--non-interactive` | ask nothing; a required value without a default fails and names its flag |
| `--yes` | confirm every change without asking |
| `--json` | machine-readable output on stdout (`status`, `doctor`, `backup`) |
| `--help` | the command's options |

| Command | Options |
|---|---|
| `init selfhost` | `setup.sh`'s: `--call`, `--passcode`, `--filter`, `--domain`, `--tunnel-token`, `--lan-host`, `--site-call`, `--fed-peers`, `--fed-submit-instances`, `--fed-registry-key`, `--net44-name`, `--app-port`, `--no-tunnel`, `--no-next-steps`, `--env-file`, `--no-network`; and `--net44-config FILE`, which brings a 44Net Connect tunnel up afterwards (`net44 setup`) |
| `init baremetal` | `--dir`, `--user`, `--repo`, `--ref`, `--port`, `--no-start`, `--checksum-only`, `--dry-run`, `--net44-config`, and `setup.sh`'s |
| `init ingest-box` | `--gateway`, `--code`, `--shared-secret`, `--box`, `--label`, `--call`, `--passcode`, `--filter`, `--kiss`, `--meshcom`, `--site-call`, `--no-start` |
| `init cloudflare` | `--api-base`, `--app-url` |
| `init pocket`, `init desktop` | Pocket's `wizard.sh` options; none |
| `status`, `doctor` | none |
| `backup` | `--dest`, `--with-media`, `--no-settings` |
| `restore <archive>` | `--dry-run`, `--no-settings`; the archive may be `oci://<bucket>/<object>` or `oci://<bucket>/latest` |
| `update` | `--ref`, `--rollback-window` |
| `rotate-secret <name>` | none |
| `net44 setup <connect.conf>` | `--name`, `--mtu`, `--no-firewall` ([44Net](../run/networks/44net.md)) |
| `net44 status`, `net44 check [name]`, `net44 remove` | none |

## Operator callsign — `tools/admin/` {#operator-callsign}

```bash
docker compose exec gateway node tools/admin/verify-call.mjs OE8APR                   # Docker stack, from deploy/
BASE=https://api.example.net OPERATOR_SECRET=… node tools/admin/verify-call.mjs OE8APR   # from a checkout
```

Confirms the operator's own callsign so the sysop role opens on a fresh instance. Run it after signing in
as that call — claiming a call clears a verification recorded while nobody held it. It posts to
`/verify/operator` with `OPERATOR_SECRET` (`x-operator-secret`; refused while the gateway has none); the
gateway accepts only a call listed in `ADMIN_CALLSIGNS` and marks it verified (method `operator`). Before it
verifies, the script prints the account that holds the call (its id and creation date, the call it operates,
its passkey count, whether it has a confirmed email) and asks `Verify … for this account? [y/N]`; `--yes`
answers for it, and a run without a terminal needs `--yes`. A call no account holds is not verified. `BASE`
defaults to the gateway on this host, `http://127.0.0.1:$PORT` (`PORT` defaults to `8787`; the gateway
container sets `8080` and carries `OPERATOR_SECRET`, so the Docker form needs neither). See
[Who is a sysop](secrets.md#who-is-a-sysop).

## Sign-in link — `tools/admin/` {#signin-link}

```bash
docker compose exec gateway node tools/admin/signin-link.mjs OE8APR                   # Docker stack, from deploy/
BASE=http://127.0.0.1:8787 OPERATOR_SECRET=… node tools/admin/signin-link.mjs OE8APR     # from a checkout
```

Prints a one-time sign-in link: the way in on an off-grid instance, where passkeys (no https origin) and
email are unavailable. It posts to `/auth/operator-link` with `OPERATOR_SECRET`. The link is single-use,
expires in 15 minutes, opens a confirm page (opening it signs nobody in), and signs in the account holding
the call — or creates one, unverified, for a new call. It never verifies a callsign. On an instance where
passkeys or email work, the gateway issues links only for `ADMIN_CALLSIGNS` calls, unless it runs with
`OPERATOR_LINKS_FOR_ANY_CALL=1`. Run from the box itself, the link names `APP_URL`.

`--link-origin <origin>` names another origin for the link: the station's https hotspot origin
(`https://<its private IPv4 address>:<HTTPS_PORT>`), the one a visitor's phone opens. The gateway refuses any
origin other than that and `APP_URL`. `--qr` also prints the link as a QR code for the phone to scan (Node
22.18 or later). `BASE` stays the address the script reaches the gateway on.

```bash
OPERATOR_SECRET=… node tools/admin/signin-link.mjs --link-origin https://192.168.43.1:8443 --qr OE8VIS
```

See [Off-grid sign-in](../run/day-to-day/sign-in-links.md#off-grid-sign-in).

## Licence registers — `tools/licence/` {#licence-registers}

```bash
BASE=https://api.example.net OPERATOR_SECRET=… node tools/licence/import.mjs --source fcc,ised,acma,at,de
node tools/licence/import.mjs --source all                    # every register
node tools/licence/import.mjs --source de --file liste.pdf    # a file already downloaded (.zip, .pdf or pdftotext .txt)
node tools/licence/import.mjs --source ised --dry-run         # parse and count; send nothing
node tools/licence/import.mjs --list                          # the registers and their ids
```

Imports public amateur licence registers for the [register badge](licence-sources.md). Each register is
downloaded and parsed on this machine; only callsign, status and expiry are posted, in batches of 1000, to
`/api/licence/import` with `OPERATOR_SECRET`, and the run is closed with `/api/licence/import/finish`, which
removes calls the register no longer lists. With no `--source`, `LICENCE_SOURCES` (comma-separated) names
the registers, for scheduled runs. `BASE` (or `--base`) defaults to `http://127.0.0.1:8787`. The PDF
registers need `pdftotext` (poppler-utils). Exits non-zero if any register fails. See
[Licence registers](../run/day-to-day/licence-registers.md).

## Federation keys — `tools/fedkey/`

```bash
node tools/fedkey/genkey.mjs            # generate an instance signing key
```

Prints `FED_PRIVATE_KEY` (set it as a secret) and the public key it will publish. Add `--raw` for
machine-readable output. Related:

- `node tools/fedkey/rotatekey.mjs` — produce a signed rotation record (a new key vouched for by the old
  one) for `FED_ROTATIONS`, so peers accept the new key without interruption, and the old key for
  `FED_KEY_HISTORY` with an `until` of the rotation time plus `FED_ROTATION_GRACE_DAYS` (default 7): peers
  stop accepting the old key after that.
- `node tools/fedkey/signregistry.mjs '<entries-json>'` — sign an instance-registry document with an
  authority key, producing `FED_REGISTRY` + `FED_REGISTRY_KEY`.

## Tool signing — `tools/toolkey/` {#toolkey}

Sign tool plugins and the tool registry so the app can verify them (see
[the tools platform](../shack/index.md#tools-and-plugins)):

```bash
node tools/toolkey/genkey.mjs                                   # a tool-author keypair
TOOL_PRIVATE_KEY=… node tools/toolkey/sign.mjs manifest tool.json   # sign a tool manifest
TOOL_PRIVATE_KEY=… node tools/toolkey/sign.mjs registry registry.json  # sign a registry's entries
```

The signer canonicalises exactly as the app's verifier does, so the app verifies byte-for-byte what you
signed.

## Development & conformance

The contributor commands — `pnpm run check`, `smoke`, `verify`, `conformance:meshcom` — the smoke and e2e
suites, the CI guards under `tools/checks/` and the interop tests are described in
[Testing & verification](../contribute/testing.md).

!!! note
    `tools/teaser/` and `tools/webauthn/` are internal build/marketing and test helpers, not operator tools.

## Next

- [The deploy/aprscaching command](../run/day-to-day/helper-command.md): the tasks it runs, step by step.
- [Configuration](configuration.md): every setting the gateway reads.
