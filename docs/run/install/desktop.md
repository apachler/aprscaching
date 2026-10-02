# Desktop

**With the helper:** `deploy/aprscaching init desktop` says where to download the binary and how to check
it ([Verified downloads](verified-downloads.md)).

One executable (`bun build --compile`) with the gateway, the web app and the migrations inside. It keeps
SQLite in the OS data directory and generates `INGEST_SECRET`, `OPERATOR_SECRET` and `SESSION_SECRET` there on
first run. Best for one operator, a field day, or trying it out; it works off-grid.

The download and its checks are under [Check a download](verified-downloads.md); the build is described in `deploy/desktop/README.md`.

## Next

- [Your first hour](../first-hour.md).
