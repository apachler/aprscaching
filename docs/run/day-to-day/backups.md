# Backups and moving

This page is for the sysop. It shows how to back up an instance on every shape, how to restore it, and how to
move it to another shape; at the end a scheduled backup runs and `doctor` reports its age.

## Before you start

- A working instance and its checkout ([the deploy/aprscaching command](helper-command.md)).
- A place for backups that is not the database's own disk: a mounted directory, an OCI bucket or an
  S3-compatible bucket (Cloudflare R2, AWS S3).

## What to back up

Caches, finds, accounts and keys are the record of your instance; positions age out on their own. A complete
backup holds:

- **the database**, SQLite on every shape;
- **the settings**, the shape's `.env`, with the secrets in it;
- **the generated secrets** beside the database (`session.secret`; on the desktop also the ingest and operator
  secrets);
- **the media**: uploaded cache media and audio clues. They are files (`MEDIA_DIR`; in the Docker stack
  `/data/media` in the `data` volume), never rows in the database.
  `MEDIA_QUOTA_MB` (default 1024) caps how much the instance stores, so size it to the disk or bucket.

Pick the tool for your shape:

| Shape | Tool | What it writes |
|---|---|---|
| Self-host, bare metal, Desktop | `deploy/aprscaching backup`, scheduled | a portable archive: rows, settings, secrets, optionally media |
| Self-host, bare metal (SQLite file on the host) | `deploy/backup.sh` from cron | a gzipped SQLite snapshot only |
| Pocket | `deploy/pocket/backup.sh`, or `deploy/aprscaching backup` | an archive in the phone's shared storage |

**When to use which.** `deploy/aprscaching backup` writes the one archive that `restore` reads on any shape:
use it for scheduled backups, before risky changes and to move between shapes. `deploy/backup.sh` takes only
the database, with no settings and no media; it suits a host that already backs up its files and wants an
off-host copy of the database every night.

## The backup archive

```bash
deploy/aprscaching backup                           # database rows, settings, generated secrets, manifest
deploy/aprscaching backup --with-media --dest /mnt/usb
deploy/aprscaching backup --no-settings             # leave the .env out
```

Run it from the checkout's root directory. It writes `aprscaching-<shape>-<UTC time>.tar.gz` to `--dest`, else
`BACKUP_DIR`, else `deploy/backups`. The archive holds:

- `rows.sql`: every row of the database as SQL, with the newest migration it had. The rows are read in one
  transaction, so the gateway keeps running.
- `settings.env`: the `.env`, unless `--no-settings`.
- `secrets/`: the secret files the gateway generated beside its database.
- `media/`: only with `--with-media`.
- `manifest.json`: the shape, the time, the schema, the commit and the row counts.

The archive holds the instance's secrets, so it is created readable by its owner only. Keep it off shared
folders.

Each run keeps the newest 14 of the shape's archives in that place and deletes the older ones, so the disk use
stays bounded. `BACKUP_KEEP` in `deploy/.env` sets another number.

**To a bucket.** With `OCI_BUCKET` set, `backup` also uploads the archive to that bucket under `archives/` (it
needs the `oci` CLI). It never deletes from the bucket: expire
`archives/` with a lifecycle rule ([Bucket lifecycle](#bucket-lifecycle)). The OCI one-click stack sets this up
with a nightly timer, `aprscaching-backup.timer`, that runs `backup --with-media`
(`deploy/oci/README-stack.md`).

**On a schedule.** Run it from cron on any shape that supports it, for example every night at 03:30:

```bash
30 3 * * * cd /opt/aprscaching && deploy/aprscaching backup
```

## Scheduled snapshots with backup.sh

`deploy/backup.sh` takes a consistent SQLite `.backup` snapshot while the gateway writes, gzips it and copies it
to one destination. It needs the `sqlite3` command and reads its settings from the environment, so the cron
entry supplies them:

```bash
0 3 * * * DB_PATH=/opt/aprscaching/data/aprscaching.db BACKUP_DIR=/mnt/backups /opt/aprscaching/deploy/backup.sh
```

| Setting | Meaning | Default |
|---|---|---|
| `DB_PATH` | the SQLite file | `/opt/aprscaching/data/aprscaching.db` |
| `BACKUP_DIR` | a local or mounted directory; use a disk that is not the database's | — |
| `OCI_BUCKET` | an OCI Object Storage bucket; needs the `oci` CLI | — |
| `BACKUP_BUCKET` + `R2_ENDPOINT` | an S3-compatible bucket (Cloudflare R2, AWS S3); needs the `aws` CLI | — |
| `BACKUP_RETENTION_DAYS` | days a snapshot is kept | `30` |
| `BACKUP_PRUNE_BUCKET` | `1` deletes expired bucket snapshots too | `0` |

Set exactly one destination; the first one set in the order of the table wins. With none set, the script
exits with status `2`, so cron reports the failure instead of a silent no-op. It prints
`backup: wrote …` or `backup: uploaded …` when it succeeds.

### Bucket lifecycle

In `BACKUP_DIR`, the script deletes snapshots older than `BACKUP_RETENTION_DAYS`. A bucket destination is
append-only: the script never deletes from it, so the bucket key needs no delete permission and a compromised
host cannot wipe its own backups. A bucket therefore **needs a lifecycle rule** that expires old objects. Set
it once when you create the bucket: on the `db/` prefix for `backup.sh` snapshots, and on `archives/` for
`deploy/aprscaching backup` archives.

```bash
# AWS S3 (Cloudflare R2 and other S3-compatible stores: add --endpoint-url "$R2_ENDPOINT")
aws s3api put-bucket-lifecycle-configuration --bucket <bucket> --lifecycle-configuration \
  '{"Rules":[{"ID":"expire-db","Status":"Enabled","Filter":{"Prefix":"db/"},"Expiration":{"Days":30}}]}'
# OCI Object Storage (the tenancy also needs a policy that lets the objectstorage-<region> service
# manage object-family in the bucket's compartment)
oci os object-lifecycle-policy put -bn <bucket> --items \
  '[{"name":"expire-db","action":"DELETE","timeAmount":30,"timeUnit":"DAYS","isEnabled":true,"objectNameFilter":{"inclusionPrefixes":["db/"]}}]'
```

Where a lifecycle rule is not available, `BACKUP_PRUNE_BUCKET=1` makes `backup.sh` delete bucket snapshots older
than `BACKUP_RETENTION_DAYS` after each upload, judged by the timestamp in the snapshot's name. The bucket key
then needs delete permission.

## Pocket

On a phone, `deploy/pocket/backup.sh` writes the station to the phone's shared storage. Run these in Termux:

```bash
termux-setup-storage                                  # once: allow Termux to write to shared storage
bash ~/aprscaching/deploy/pocket/backup.sh            # to ~/storage/shared/aprscaching-backups/
```

The archive, `aprscaching-pocket-<UTC time>.tar.gz`, holds a consistent snapshot of the database taken while the
gateway runs, the `.env`, `session.secret` and the media while it is at most 50 MiB
(`APRSCACHING_BACKUP_MEDIA_MAX_MB`; `--media` or `--no-media` decides it yourself). The newest 7 are kept
(`--keep <n>`); `--dest <dir>` writes elsewhere.

Shared storage is readable by any app with storage permission. `--no-env` leaves the `.env` and the secret files
out of the archive.

To restore one, run `bash ~/aprscaching/deploy/pocket/backup.sh --restore <file>`. It stops the station, moves
the current database, media and secrets aside to `~/.aprscaching/before-restore-<time>/`, puts the archive's in
place and starts the station again if it was running. The `.env` comes back only with `--with-env`. `deploy/aprscaching restore`
accepts these archives too. The station CA stays on the phone; a station restored elsewhere makes a new one.

[Pocket extras](../pocket/extras.md) schedule this backup to run daily while the phone charges.

## Restore

`restore` replaces the instance's data with an archive's. Run it in the checkout's root directory:

```bash
deploy/aprscaching restore aprscaching-selfhost-20261001T120000Z.tar.gz --dry-run
deploy/aprscaching restore aprscaching-selfhost-20261001T120000Z.tar.gz
deploy/aprscaching restore oci://aprscaching-backups/latest      # the newest archive in an OCI bucket
```

1. It refuses an archive from a newer schema than this checkout knows. [Update](updates.md) first.
2. `--dry-run` shows what it would restore and changes nothing. Without `--yes` it asks before it changes
   anything.
3. It stops the instance and builds a new database: the migrations up to the archive's schema, then its rows,
   then every newer migration. The old database stays beside it as `before-restore-<time>-*`.
4. It restores the instance's settings: identity, secrets, federation, operator. It keeps this host's own:
   `INGEST_URL`, paths, ports, `DOMAIN`, the tunnel token, `TRUST_PROXY`, `TRUST_CF` and the box's key.
   `--no-settings` leaves every setting as it is.
5. It restores the secret files and any media, starts the instance and runs `doctor`.

The rows come back exactly as the archive holds them. Federation needs nothing more: the instance numbers every new
cache, find and deletion at least by the time in milliseconds, so its peers never take a new record for one they
already hold, and a peer the instance trusts tells it how far it holds the instance's records, which raises the
numbering past that even on a box whose clock is behind
([Numbers are never reused](../../reference/federation-trust.md#records-passed-on-through-hubs)).

## Moving between shapes

Take a backup on the old shape, `init` the new one, then `restore` there: for example Pocket to Self-host, or
Self-host to bare metal. Keep these the same:

- **`APP_URL`**, and with it `RP_ID`: passkeys are bound to that domain, and a new one locks every member's
  passkey out.
- **The federation signing key**, which moves inside the archive: peers pin it, and a new key breaks their
  trust.

After the move, point the ingest box at the new address, or enroll it again
([Set up an ingest box](../radios/ingest-box.md)).

## Check that it worked

Run `deploy/aprscaching doctor` and read the `resources` group:

- `resources.backup` passes while the newest archive is at most 7 days old (`APRS_BACKUP_MAX_DAYS`). It looks
  for `deploy/aprscaching backup` archives in `BACKUP_DIR`, in `deploy/backups`, or under `archives/` in
  `OCI_BUCKET` when the `oci` CLI is installed. On Pocket it looks in the phone's shared storage.
- `resources.backup_place` warns when the backups stay on this host's disk: no `BACKUP_DIR`, and no bucket
  with the CLI that uploads to it. `BACKUP_BUCKET` takes the snapshots of `deploy/backup.sh`, not these
  archives.

[Troubleshooting](../troubleshooting.md#resourcesbackup) explains each message.

## Next

- [Updates](updates.md): every update takes a backup first and can roll back to it.
- [A public instance's duties](../compliance/index.md): why a public instance must keep backups.
