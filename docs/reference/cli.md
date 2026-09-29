# Command-line tools

Helper scripts under `deploy/` install and maintain an instance; those under `tools/` confirm the operator's
callsign and support key management, signing, and verification.

## Instance operation — `deploy/`

```bash
cd deploy && ./setup.sh                  # first-run wizard: writes .env (operator call, APP_URL, APRS-IS feed, site call, INGEST_SECRET, OPERATOR_SECRET, FED_PRIVATE_KEY)
deploy/setup.sh --non-interactive --call OE8APR --domain aprs.example.net   # the same from flags (--help lists them)
deploy/backup.sh                         # SQLite snapshot, uploaded to BACKUP_DIR / OCI_BUCKET / BACKUP_BUCKET — run nightly from cron
deploy/cloudflare/deploy-cf.sh           # one-shot Cloudflare core (Worker + D1 + R2 + Pages); needs wrangler + Cloudflare login
deploy/cloudflare/cache-rules.sh         # Cloudflare cache rules for a CDN in front of a VM; needs CF_API_TOKEN + CF_ZONE_ID
```

See [Deployment](../operate/deployment.md) and [Running in Docker](../operate/docker.md).

`setup.sh` keeps every value already in `.env` unless you confirm the change (or pass `--yes`), and never
regenerates a secret that is set.

## Operator callsign — `tools/admin/` {#operator-callsign}

```bash
docker compose exec gateway node tools/admin/verify-call.mjs OE8APR                   # Docker stack, from deploy/
BASE=https://api.example.net OPERATOR_SECRET=… node tools/admin/verify-call.mjs OE8APR   # from a checkout
```

Confirms the operator's own callsign so the sysop role opens on a fresh instance. Run it after signing in
as that call — claiming a call clears a verification recorded while nobody held it. It posts to
`/verify/operator` with `OPERATOR_SECRET` (`x-operator-secret`; refused while the gateway has none); the
gateway accepts only a call listed in `ADMIN_CALLSIGNS` and marks it verified (method `operator`). `BASE`
defaults to the gateway on this host, `http://127.0.0.1:$PORT` (`PORT` defaults to `8787`; the gateway
container sets `8080` and carries `OPERATOR_SECRET`, so the Docker form needs neither). See
[Administration](../operate/administration.md#operator-identity).

## Sign-in link — `tools/admin/` {#signin-link}

```bash
docker compose exec gateway node tools/admin/signin-link.mjs OE8APR                   # Docker stack, from deploy/
BASE=http://127.0.0.1:8787 OPERATOR_SECRET=… node tools/admin/signin-link.mjs OE8APR     # from a checkout
```

Prints a one-time sign-in link: the way in on an off-grid instance, where passkeys (no https origin) and
email are unavailable. It posts to `/auth/operator-link` with `OPERATOR_SECRET`. The link is single-use,
expires in 15 minutes, opens a confirm page (opening it signs nobody in), and signs in the account holding
the call — or creates one, unverified, for a new call. It never verifies a callsign. On an instance where
passkeys or email work, the gateway issues links only for `ADMIN_CALLSIGNS` calls. Run from the box itself,
the link names `APP_URL`. See [Off-grid sign-in](../operate/first-hour.md#off-grid-sign-in).

## Licence registers — `tools/licence/` {#licence-registers}

```bash
BASE=https://api.example.net OPERATOR_SECRET=… node tools/licence/import.mjs --source fcc,ised,acma,at,de
node tools/licence/import.mjs --source all                    # every register
node tools/licence/import.mjs --source de --file liste.pdf    # a file already downloaded (.zip, .pdf or pdftotext .txt)
node tools/licence/import.mjs --source ised --dry-run         # parse and count; send nothing
node tools/licence/import.mjs --list                          # the registers and their ids
```

Imports public amateur licence registers for the [licence badge](licence-sources.md). Each register is
downloaded and parsed on this machine; only callsign, status and expiry are posted, in batches of 1000, to
`/api/licence/import` with `OPERATOR_SECRET`, and the run is closed with `/api/licence/import/finish`, which
removes calls the register no longer lists. With no `--source`, `LICENCE_SOURCES` (comma-separated) names
the registers, for scheduled runs. `BASE` (or `--base`) defaults to `http://127.0.0.1:8787`. The PDF
registers need `pdftotext` (poppler-utils). Exits non-zero if any register fails. See
[Administration](../operate/administration.md#licence-registers).

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
[the tools platform](../guides/shack.md#tools-and-plugins)):

```bash
node tools/toolkey/genkey.mjs                                   # a tool-author keypair
TOOL_PRIVATE_KEY=… node tools/toolkey/sign.mjs manifest tool.json   # sign a tool manifest
TOOL_PRIVATE_KEY=… node tools/toolkey/sign.mjs registry registry.json  # sign a registry's entries
```

The signer canonicalises exactly as the app's verifier does, so the app verifies byte-for-byte what you
signed.

## Development & conformance — `tools/dev/`

```bash
pnpm run check          # tools/dev/check.sh — build (typecheck) every unit + run every unit test suite
pnpm run smoke          # tools/dev/smoke.sh — a throwaway Node/SQLite gateway + the runtime conformance suites
pnpm run verify         # tools/dev/verify.sh — check + smoke, the full pre-commit gate
pnpm run conformance:meshcom   # the MeshCom core on Node, Bun and workerd (tools/conformance/meshcom.mjs)
```

CI guards under `tools/checks/`: `oci-stack.mjs` keeps the Oracle Cloud one-click stack consistent, and
`worker-bundle.mjs` proves the Cloudflare Worker bundle carries no RF socket code. `tools/interop/` runs
interoperability tests against reference packet software (LinBPQ, FBB, JNOS, aprsc); see its README.

The smoke suites themselves live in `tools/smoke/` (`smoke.mjs`, `geofence.mjs`, and the two-instance
`federation.mjs`) and run against any running gateway via `BASE=…`. `tools/e2e/audio-mic.mjs` drives the live
microphone decode path headlessly in Chromium (used by CI).

!!! note
    `tools/teaser/` and `tools/webauthn/` are internal build/marketing and test helpers, not operator tools.
