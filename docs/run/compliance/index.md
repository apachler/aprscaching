# A public instance's duties

A public instance owes its users two things by licence and by law: its source, and a backup of their records.

1. **Expose your source (AGPL §13).** Set `SOURCE_REPO` to your published fork and keep `SOURCE_COMMIT`
   accurate. Every instance serves a machine-readable descriptor at `GET /.well-known/source` and shows a
   "Source" link in the UI. This is required, not optional.
2. **Back up your database.** Positions are TTL'd, but caches, finds, accounts, and keys are the record of
   your instance — back up the D1/SQLite database ([Backups](../day-to-day/backups.md#what-to-back-up)).

## Next

- [Automatic stations on the air](on-air-stations.md).
- [Data protection (GDPR)](data-protection.md).
