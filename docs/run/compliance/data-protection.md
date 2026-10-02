# Data protection (GDPR)

Sensitive account actions are authorised by the account's own session or a signature from a device key
registered to the callsign — there is no central password. A device key is registered only by the signed-in
holder of the call; no machine secret registers one.

- **Export** (`POST /api/account/:call/export`) returns a full machine-readable copy of the account's data.
- **Erase** (`/delete`) covers the whole account: every base call it holds. It anonymises finds, owned
  caches and messages to a withdrawn marker (served as `WITHDRAWN`; the name can never be registered),
  archives owned caches (a sysop can offer them for [adoption](../day-to-day/cache-adoption.md)) and removes their
  uploaded media, deletes every personal row — passkeys, email links, held calls, watches, alerts, saved
  views, push subscriptions, boxes, ratings, API keys, adoption requests and personal BBS mail — frees the base calls for a new registration, and emits a **PII-free tombstone** so
  federation peers purge their mirrored copies.
- **Portability** (`/bundle`, `/move`, `/api/account/import`) lets a user migrate a callsign to another
  instance; because finds are device-signed, history stays attributable, and an account-move record
  re-points attribution across the network.

The licence registry (`licence_registry`) holds public-register facts about callsigns — callsign, status,
expiry, source and import date, never a name or address — so it is outside export and erasure. Each import
replaces a register's rows and deletes calls it no longer lists.

Positions are TTL'd; the retained record is public ham identifiers and APRS positions that are public by
design on RF/APRS-IS. Delete tombstones are kept permanently: they carry only PII-free global ids, and
every mirror consults them so deleted data is never re-mirrored.

## Privacy across the network

GDPR deletions propagate as **signed, PII-free tombstones** that name only a global record id (never a
callsign); consumers purge the mirrored rows and suppress re-mirroring. Tombstones are kept permanently on
both sides: they hold only ids, and a mirror checks them on every upsert so deleted data never comes back. Account portability works the same
way — a signed account-move record re-points attribution when a user migrates instances.

## Next

- [Is running an instance for me?](../index.md).
