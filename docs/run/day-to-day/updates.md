# Updates

How to bring an instance up to a new release.

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

## Next

- [One-time sign-in links](sign-in-links.md).
