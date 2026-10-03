# Licence registers

This page is for the sysop. It shows how to import the public licence registers that the register badge reads,
and how to keep them fresh on a schedule.

The register badge shows whether a public register lists a call as licensed
([Licence registers](../../reference/licence-sources.md) lists the sources). It needs the registers imported;
until then every call reads "not in a public register", and nothing else changes.

## Before you start

- A machine with Node 22 or newer and a checkout: the ingest box, or any computer.
- The instance's `OPERATOR_SECRET`, and the gateway's address.
- For the PDF registers (`at`, `de`): `pdftotext`, from `apt install poppler-utils`.

## Import the registers

Run these in the checkout's root directory:

```bash
node tools/licence/import.mjs --list                    # the registers it knows
BASE=https://api.example.net OPERATOR_SECRET=… node tools/licence/import.mjs --source fcc,ised,acma,at,de
node tools/licence/import.mjs --source all              # every register
node tools/licence/import.mjs --source ised --dry-run   # parse and count, send nothing
```

The tool downloads each register, keeps only callsign, status and expiry, and posts them to the gateway.
`BASE` defaults to `http://127.0.0.1:8787`. `--file <path>` reads a register already on disk instead of
downloading it.

The FCC file is about 200 MB and lists about 1.6 million calls; allow a few minutes for its download and import.
Each import replaces that register's rows, and calls it no longer lists are removed. An import that fails
part-way removes nothing. The tool exits non-zero when any register fails.

## Keep it fresh on a schedule

With no `--source`, the tool reads the registers from `LICENCE_SOURCES`, so a scheduled run needs only the
environment. The FCC rebuilds its full file weekly and the other registers change more slowly, so a weekly run
is enough. With cron:

```bash
# /etc/cron.d/aprscaching-licence: Sundays 04:30
30 4 * * 0  aprs  cd /opt/aprscaching && BASE=http://127.0.0.1:8787 OPERATOR_SECRET=… LICENCE_SOURCES=fcc,ised,at,de node tools/licence/import.mjs
```

With a systemd service and a `.timer` beside it (`OnCalendar=weekly`):

```ini
# /etc/systemd/system/aprscaching-licence.service
[Service]
Type=oneshot
WorkingDirectory=/opt/aprscaching
EnvironmentFile=/opt/aprscaching/deploy/.env
Environment=LICENCE_SOURCES=fcc,ised,at,de
ExecStart=/usr/bin/node tools/licence/import.mjs
```

## Check that it worked

For each register the tool prints `<id>: <n> calls imported, <m> no longer listed removed`. A licensed call's
profile then shows the register badge. The registry holds no user data, so it is outside export and erasure
([Data protection](../compliance/data-protection.md)).

## Next

- [Import heritage places](import-places.md): another import, for caches.
