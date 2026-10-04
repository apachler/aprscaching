# A public instance's duties

This page is for the sysop of an instance other people use. It lists what the instance owes them by licence and
by law: its source code, and a backup of their records.

## Publish your source (AGPL §13)

The hosted app is licensed AGPL-3.0-or-later, so everyone who uses your instance over the network has a right
to its source. Every instance serves a machine-readable descriptor at `GET /.well-known/source` and shows a
**Source** link in the app. You keep both accurate:

- **`SOURCE_REPO`** names the published repository. It defaults to the upstream project; if you changed the
  code, publish your fork and set `SOURCE_REPO` to it.
- **`SOURCE_COMMIT`** names the commit the instance runs. A deploy from a git checkout resolves it at build or
  start. The Docker image cannot see `.git`, so the stack passes it at build:
  `SOURCE_COMMIT=$(git rev-parse HEAD) docker compose up -d --build`, run in `deploy/`.

This is required, not optional.

## Back up the database

Positions age out on their own, but caches, finds, accounts and keys are the record of your instance. Back up
the SQLite database, the settings and the media, and keep a copy off the instance's own disk
([What to back up](../day-to-day/backups.md#what-to-back-up)).

## Name the operator

A public instance shows who runs it at `/imprint` and how it handles data at `/privacy`. Set
`OPERATOR_NAME`, `OPERATOR_ADDRESS` and `OPERATOR_EMAIL`; they are *Recommended* items in **Instance admin →
Setup** ([Your first hour](../first-hour.md)).

`/.well-known/security.txt` (RFC 9116) tells a security researcher where to report a problem with your
instance. It names `SECURITY_CONTACT`, or `mailto:` + `OPERATOR_EMAIL` when that is unset, and answers 404
while neither is set. A separate address keeps reports apart from other mail, for example
`SECURITY_CONTACT=mailto:security@aprscaching.net` on the project's own instance. Web push names the same
operator address to the push services, unless `VAPID_SUBJECT` says otherwise.

## Check that it worked

Run `deploy/aprscaching doctor`:

- `source.link` passes when `/.well-known/source` names the repository and the commit;
- `source.fork` warns when the checkout has local changes but `SOURCE_REPO` is still the upstream;
- `resources.backup` passes while the newest backup is at most 7 days old.

[Troubleshooting](../troubleshooting.md#sourcelink) explains each result.

## Next

- [Data protection (GDPR)](data-protection.md): what members can export and erase, and what the instance keeps.
- [Automatic stations on the air](on-air-stations.md): the rules for an instance that transmits.
