# Data model

The gateway's schema is a set of ordered SQL migrations under `db/migrations/`, applied identically on every
runtime (D1's `wrangler d1 migrations apply`, or the Node/Bun migration runner, which tracks applied files by
name). To add schema, add the next-numbered `NNNN_name.sql` file — never edit an applied migration.

Spatial lookups use a plain lat/lon index (D1 does not support rtree virtual tables). Firehose positions are
TTL'd; the durable record is caches, finds, accounts, and keys — back those up.

## What the tables cover

The schema groups into a handful of domains:

| Domain | Holds | Representative migrations |
|--------|-------|---------------------------|
| **Caching** | Caches, logbook, ratings, favorites, staged/NFC unlocks, media, rendezvous, metadata & tags | `0001`, `0007`, `0031`–`0035` |
| **Positions & stations** | The live station registry, firehose positions, telemetry & weather readings, the recent-packet ring | `0001`, `0024`, `0025`, `0029`, `0030` |
| **Accounts & identity** | Accounts, base callsigns, passkeys, device keys, callsign control-verification, profiles, preferences | `0002`, `0005`, `0008`, `0010`, `0011`, `0023`, `0039` |
| **Verification** | Corroboration state and the corroborating-IGate credit | `0004`, `0026` |
| **Federation** | Mirrored remote caches/finds/keys, peers + trust + reputation, sync observability, tombstones, federation scope, account-moves, the relay queue | `0003`, `0013`–`0017`, `0028`, `0042` |
| **BBS & node** | Store-and-forward mail, bulletins, threads, FBB forwarding partners/rules/log, White Pages, the NET/ROM node table | `0009`, `0036`–`0038`, `0040`, `0041` |
| **Engagement** | Watchlists, saved map views, notifications, API keys, recognition/monetization | `0018`–`0022` |

## First and current

- `0001_init` establishes caches, logs, positions, accounts, and the core workbench tables.
- The latest migration is `0042_fed_relay` (the federation rendezvous relay queue).

The typed data contracts that cross the wire — `Packet`, `Provenance`, the WebSocket messages, and the DTOs —
live in `@aprsweb/shared` (Zod schemas) and are the source of truth for request/response shapes.
