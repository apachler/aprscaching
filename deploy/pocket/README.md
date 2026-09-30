# deploy/pocket/

**Pocket** runs the gateway (`servers/node`, SQLite) and the ingest (`apps/ingest`) on an Android phone
in [Termux](https://termux.dev), without root: a field-day or demo station, not a 24/7 server. Android
stops background apps, and battery and heat are real limits.

| File | Purpose |
|---|---|
| `install.sh` | installs the Termux packages, clones or updates `~/aprscaching`, installs only what the gateway, the ingest and the web build need, compiles better-sqlite3 for Android, builds the web app, writes `~/.aprscaching/.env` on the first run and starts the gateway once to apply the migrations; safe to re-run |
| `.env.pocket.example` | the settings `install.sh` starts from (gateway on port 8787, ingest to localhost) |

## Install

Use Termux from [F-Droid](https://f-droid.org/packages/com.termux/) or its
[GitHub releases](https://github.com/termux/termux-app/releases), then in Termux:

```bash
apt update && apt full-upgrade -y   # bring every package to one consistent version first
termux-change-repo                  # pick a mirror group if pkg reports that none is selected
curl -fsSLO https://raw.githubusercontent.com/apachler/aprscaching/main/deploy/pocket/install.sh
bash install.sh --call <YOURCALL>
```

Upgrade with `apt`, not `pkg`: `pkg` itself runs `curl`, and a half-upgraded Termux (a new `curl` against an
older OpenSSL) stops `curl` with `cannot locate symbol "SSL_…"` until the upgrade completes.

`bash install.sh --help` lists the options (another branch or repository, a web build copied from a PC,
a dry run). The script prints how to start the gateway and the ingest, and Chrome on the phone opens the
station at `http://localhost:8787`.

The operator guide is `docs/operate/pocket.md`.
