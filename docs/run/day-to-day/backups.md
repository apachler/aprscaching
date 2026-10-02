# Backups and moving

What to back up, how, and how to move an instance to another shape.

## What to back up

`deploy/aprscaching backup` writes a portable archive on every shape — database rows, settings and generated
secrets — that `deploy/aprscaching restore` puts back on the same shape or another
([Backup and restore](#backup-and-restore)). With `OCI_BUCKET` set it also uploads the archive to
that bucket, and `restore oci://<bucket>/latest` brings it back; the OCI one-click stack schedules it nightly
into a bucket it creates. For scheduled, off-host copies:

- **Self-host and Desktop (SQLite):** cron `deploy/backup.sh`. It takes a consistent SQLite `.backup`
  snapshot, gzips it, and uploads it to `BACKUP_DIR`, an OCI bucket or any S3-compatible endpoint (see
  `deploy/.env.example`); it exits non-zero when no destination is set. Uploaded cache media is stored as files (`MEDIA_DIR`;
  in the Docker stack `/data/media` in the `data` volume), not in the database — include that directory in
  your host backup, or pass `--with-media` to `deploy/aprscaching backup`.

    **Retention.** `BACKUP_DIR` snapshots older than `BACKUP_RETENTION_DAYS` (default 30) are deleted by the
    script. A bucket destination is append-only: the script never deletes from it, so the bucket key needs no
    delete permission and a compromised host cannot wipe its own backups. A bucket destination therefore
    **needs a lifecycle rule** that expires the `db/` prefix, set once when you create the bucket:

    ```bash
    # Cloudflare R2
    npx wrangler r2 bucket lifecycle add <bucket> expire-db db/ --expire-days 30
    # AWS S3
    aws s3api put-bucket-lifecycle-configuration --bucket <bucket> --lifecycle-configuration \
      '{"Rules":[{"ID":"expire-db","Status":"Enabled","Filter":{"Prefix":"db/"},"Expiration":{"Days":30}}]}'
    # OCI Object Storage (the tenancy also needs a policy that lets the objectstorage-<region> service
    # manage object-family in the bucket's compartment)
    oci os object-lifecycle-policy put -bn <bucket> --items \
      '[{"name":"expire-db","action":"DELETE","timeAmount":30,"timeUnit":"DAYS","isEnabled":true,"objectNameFilter":{"inclusionPrefixes":["db/"]}}]'
    ```

    Where a lifecycle rule is not available, `BACKUP_PRUNE_BUCKET=1` makes `backup.sh` delete bucket snapshots
    older than `BACKUP_RETENTION_DAYS` after each upload, judged by the timestamp in the snapshot's name. The
    bucket key then needs delete permission.
- **Pocket (Termux on a phone):** `deploy/pocket/backup.sh` takes the same kind of consistent snapshot
  (SQLite's online backup, through better-sqlite3) and writes it, with the `.env` and the media, to the
  phone's shared storage, keeping the newest seven; `--no-env` leaves the secrets out.
- **Cloudflare split (D1 + R2):** `backup.sh` does not apply. D1 has **Time Travel**, a point-in-time restore
  that is always on and costs nothing extra: any minute of the last **30 days on Workers Paid** (7 days on
  Workers Free) — per Cloudflare's
  [Time Travel and backups](https://developers.cloudflare.com/d1/reference/time-travel/) page, checked
  2026-09-30.

    ```bash
    cd workers/gateway
    npx wrangler d1 time-travel info aprscaching                                  # the current bookmark
    npx wrangler d1 time-travel info aprscaching --timestamp=2026-09-29T03:00:00Z  # the bookmark for a past moment
    npx wrangler d1 time-travel restore aprscaching --timestamp=2026-09-29T03:00:00Z
    npx wrangler d1 time-travel restore aprscaching --bookmark=<bookmark>          # undo: restore the bookmark the last restore printed
    ```

    A restore overwrites the database in place and cancels in-flight queries; it prints the previous
    bookmark, so a restore can itself be undone. For history older than the retention window, keep a nightly
    SQL dump as well:
    `npx wrangler d1 export aprscaching --remote --output backup-$(date +%F).sql` from any box with a
    Cloudflare API token.

    Time Travel covers D1 only. The **R2 media** bucket (`aprscaching-media`: audio clues and cache media)
    needs its own backup plan — for example a nightly `rclone sync` from R2's S3-compatible endpoint to other
    storage, or `npx wrangler r2 object get aprscaching-media/<key> --remote --file <key>` for single
    objects.

## Backup and restore

```bash
deploy/aprscaching backup                         # one archive: database rows, settings, generated secrets, manifest
deploy/aprscaching backup --with-media --dest /mnt/usb
deploy/aprscaching restore aprscaching-selfhost-20261001T120000Z.tar.gz --dry-run
deploy/aprscaching restore aprscaching-selfhost-20261001T120000Z.tar.gz
deploy/aprscaching restore oci://aprscaching-backups/latest     # the newest archive in an OCI bucket
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

With `OCI_BUCKET` set, `backup` also uploads the archive to that bucket under `archives/` (it needs the `oci`
CLI) and keeps only the newest three on the local disk. It never deletes from the bucket: expire `archives/`
with a lifecycle rule. `restore` takes `oci://<bucket>/<object>`, or `oci://<bucket>/latest` for the newest
archive there. The OCI one-click stack sets all of this up, including a nightly timer
(`deploy/oci/README-stack.md`).

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
the archive; see [Backups](#what-to-back-up).

`deploy/backup.sh` stays the scheduled snapshot for cron: it uploads to a bucket. `doctor` counts both kinds
when it checks the age of the newest backup; for `OCI_BUCKET` it reads the age of the newest archive in the
bucket when the `oci` CLI is installed.

### Moving between shapes

Take a backup on the old shape, `init` the new one, then `restore` there. For example, Pocket → Self-host, or
Self-host → bare metal. Keep these the same:

- **`APP_URL`**, and with it `RP_ID`: passkeys are bound to that domain, and a new one locks every member's
  passkey out.
- **The federation signing key**, which moves inside the archive: peers pin it, and a new key breaks their
  trust.

After the move, point the ingest box at the new address, or enroll it again.

## Next

- [Updates](updates.md).
