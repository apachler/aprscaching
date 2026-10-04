# Updates

This page is for the sysop. It shows how to bring an instance to a new release on every shape; at the end the
instance runs the new code, or is rolled back to the old one if the update broke something.

## How you hear about a new release

Once a day the gateway asks GitHub for the newest APRScaching release. When it is newer than the release the
instance runs:

- **Instance admin** shows a note at the top with the release notes and the update command. Only sysops see it.
- `deploy/aprscaching doctor` warns with `setup.update`, naming the release and its page. It is a warning, never
  a failure, and it clears once the instance runs the new release.

The request names the instance in its User-Agent and carries nothing about a member. The privacy page lists it.
An instance with no route to GitHub never shows a release. Set `UPDATE_CHECK=0` to stop the request
([Configuration](../../reference/configuration.md)). You can also watch the repository's releases on GitHub.

## Before you start

- A checkout with no local changes: `update` refuses one that has them. Commit or stash them first.
- A backup destination, so the pre-update backup does not stay only on this disk
  ([Backups and moving](backups.md)).

## Update with the helper

Run these in the checkout's root directory:

```bash
deploy/aprscaching update                          # to the newest release tag, else the branch's head
deploy/aprscaching update --ref v1.2.0             # to a tag, branch or commit
deploy/aprscaching update --rollback-window 30     # roll back without asking for 30 minutes, not 15
```

1. It fetches, shows the current and the target version with the commits in between, and asks before it
   changes anything (`--yes` answers for you). A target that is not ahead of the running version gets a
   warning: migrations never run backward.
2. It runs `doctor` and takes a backup with `deploy/aprscaching backup`.
3. It moves the checkout to the target and brings the instance onto it:
    - Self-host: rebuild with Docker Compose, hand any file in the `data` and `webdist` volumes that another
      owner holds to the image's user (UID 10001), and restart;
    - bare metal: install, build the web app, restart the units;
    - ingest box: rebuild the ingest container.

    The gateway applies new migrations when it starts.

4. It runs `doctor` again. If a check fails that did not fail before the update, it rolls back:
    1. the database to the pre-update backup, held at the backup's schema;
    2. then the code, rebuilt and restarted.

    The rollback runs at once while the backup is younger than `--rollback-window` (15 minutes). After that
    it asks first, because a database rollback loses what was written since. An ingest box has no database, so only its code rolls back.

A failure that existed before the update does not trigger a rollback. When you decline the rollback, the helper
prints the two commands that roll back by hand.

## Self-host by hand

Without the helper, run this in `deploy/`:

```bash
git pull && SOURCE_COMMIT=$(git rev-parse HEAD) docker compose up -d --build
```

The image cannot see `.git`, so `SOURCE_COMMIT` is how its source link names the commit it runs. Migrations
apply when the gateway starts; they run forward only and are tracked in `_migrations`.

## Pocket

`deploy/aprscaching update` on a phone runs `deploy/pocket/update.sh`. How you update depends on how Pocket was
installed:

- **A release install** updates by checking and running the newer release's `pocket.sh`, the same way you
  installed it ([Install Pocket](../install/pocket.md)). It keeps the `.env` and restarts the station on the new
  code.
- **A branch install** (`--branch`) updates in Termux:

    ```bash
    bash ~/aprscaching/deploy/pocket/update.sh            # pull, install, restart
    bash ~/aprscaching/deploy/pocket/update.sh --pkg      # also upgrade the Termux packages
    ```

    The station keeps running while the update builds; the restart takes a few seconds. `--no-restart` updates
    only, and `--branch <name>` moves to another branch.

## Desktop

The desktop app updates by replacing its binary with the new release's. Take a backup first with
`deploy/aprscaching backup`. The data directory stays, and the app applies new migrations when it starts.

## Check that it worked

`update` ends with `doctor` and prints `Updated to <version>` with the path of the pre-update backup. Run
`deploy/aprscaching doctor` again any time: `gateway.migrations` passes when the database is at the newest
migration, and `gateway.version` warns while the running commit differs from the checkout's
([Troubleshooting](../troubleshooting.md#gatewayversion)).

## Next

- [Backups and moving](backups.md): restore the pre-update backup by hand.
- [Troubleshooting](../troubleshooting.md): what a failing check after an update means.
