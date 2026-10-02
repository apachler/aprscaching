# Licence registers

The licence badge shows whether a public register lists a call as licensed ([Licence
registers](../../reference/licence-sources.md)). It needs the registers imported. The import tool runs on the
operator's machine — the ingest box, or any computer with Node 22+ — downloads each register, keeps only
callsign, status and expiry, and posts them to the gateway with `OPERATOR_SECRET`:

```bash
BASE=https://api.example.net OPERATOR_SECRET=… node tools/licence/import.mjs --source fcc,ised,at,de
node tools/licence/import.mjs --list              # the registers it knows
```

The PDF registers (`at`, `de`) need `pdftotext` (`apt install poppler-utils`). The FCC file is about 200 MB and
lists about 1.6 million calls; allow a few minutes for its download and import. Each import replaces that
register's rows, and calls it no longer lists are removed; an import that fails part-way removes nothing.
Until a register is imported, every call reads "not found in public registers" — nothing else changes.

**Keep it fresh on a schedule.** Set `LICENCE_SOURCES` and run the tool from cron or a systemd timer; the
FCC rebuilds its full file weekly and the other registers change more slowly, so a weekly run is enough:

```bash
# /etc/cron.d/aprscaching-licence — Sundays 04:30
30 4 * * 0  aprs  cd /opt/aprscaching && BASE=http://127.0.0.1:8787 OPERATOR_SECRET=… LICENCE_SOURCES=fcc,ised,at,de node tools/licence/import.mjs
```

```ini
# /etc/systemd/system/aprscaching-licence.service   (+ a .timer with OnCalendar=weekly)
[Service]
Type=oneshot
WorkingDirectory=/opt/aprscaching
EnvironmentFile=/opt/aprscaching/deploy/.env
Environment=LICENCE_SOURCES=fcc,ised,at,de
ExecStart=/usr/bin/node tools/licence/import.mjs
```

The registry holds no user data (see [Data protection](../compliance/data-protection.md)).

## Next

- [Import heritage places](import-places.md).
