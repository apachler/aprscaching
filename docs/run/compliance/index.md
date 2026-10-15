# A public instance's duties

This page is for the sysop of an instance other people use. It lists what the instance owes them by licence and
by law: its source code, a backup of their records, and the pages that say who runs it and on what terms.

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

A public instance shows who runs it at `/imprint`, how it handles data at `/privacy`, and the terms of use an
account accepts at `/terms`. Set `OPERATOR_NAME`, `OPERATOR_ADDRESS` and `OPERATOR_EMAIL`; they are
*Recommended* items in **Instance admin → Setup** ([Your first hour](../first-hour.md)). Each page links the
other two, and the app links all three from the landing page, from **Settings → Help & credits** and from
sign-up.

`/.well-known/security.txt` (RFC 9116) tells a security researcher where to report a problem with your
instance. It names `SECURITY_CONTACT`, or `mailto:` + `OPERATOR_EMAIL` when that is unset, and answers 404
while neither is set. A separate address keeps reports apart from other mail, for example
`SECURITY_CONTACT=mailto:security@aprscaching.net` on the project's own instance. Web push names the same
operator address to the push services, unless `VAPID_SUBJECT` says otherwise.

`/privacy` also names who receives personal data from the instance. When mail is on it names the mail
server's host: `SMTP_HOST`, or `api.resend.com` for the Resend API ([Send mail](../day-to-day/mail.md)). An
instance that sends no mail names none. Push services appear only with web push configured, Cloudflare only
with `TRUST_CF=1`, and your hosting provider only when `HOSTING_PROVIDER` names it. For a provider based or
processing outside the EU/EEA, the page names the safeguard: the EU-US Data Privacy Framework where the provider
is certified under it, otherwise the European Commission's standard contractual clauses. It applies that to Resend,
to Cloudflare and to a hosting provider headquartered outside the EU/EEA. A processor agreement (GDPR Art. 28)
with each of them is yours to conclude.

The page gives each purpose its legal basis and its retention, read from the same settings the nightly cleanup
uses, so changing `RETENTION` or `SESSION_TTL_DAYS` changes the page too. With `BACKUP_RETENTION_DAYS` in the
gateway's environment the page says that erased data leaves the backups within that many days; keep a bucket's
lifecycle rule within the same period ([Backups](../day-to-day/backups.md#what-to-back-up)). Name the supervisory authority a member
may complain to in `PRIVACY_AUTHORITY`; unset, the page states the right to complain without naming one.
`EDITORIAL_LINE` adds the site's editorial line to `/imprint`, which Austrian media law asks of a site that does
more than present its owner.

The page also covers stations heard on the air, which are people without an account here. Telling each of them
is not possible, so the public notice takes its place (GDPR Art. 14(5)(b)). A licensee objects by email to
you. The instance has no setting that keeps one callsign out of its station data, so you answer the objection,
and what is heard from that station later ages out on the retention periods.

`/terms` is short: a free, non-commercial amateur-radio game run by `OPERATOR_NAME`, the licensee's own
responsibility for what is sent on the air, fair play, the rules for caches, logs and photos, moderation, no
warranty, erasure under **Settings → Your data**, and Austrian law. The privacy notice rests the account and play
purposes (GDPR Art. 6(1)(b)) on these terms. A change to them shows its date on the page.

## Check that it worked

Run `deploy/aprscaching doctor`:

- `source.link` passes when `/.well-known/source` names the repository and the commit;
- `source.fork` warns when the checkout has local changes but `SOURCE_REPO` is still the upstream;
- `resources.backup` passes while the newest backup is at most 7 days old.

[Troubleshooting](../troubleshooting.md#sourcelink) explains each result.

## Next

- [Data protection (GDPR)](data-protection.md): what members can export and erase, and what the instance keeps.
- [Automatic stations on the air](on-air-stations.md): the rules for an instance that transmits.
