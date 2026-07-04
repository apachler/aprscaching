# Data model

The gateway's schema lives as ordered SQL migrations under `db/migrations/`, applied identically on every
runtime (D1's `wrangler d1 migrations apply`, or the Node/Bun migration runner, which tracks applied files by
name). The 1.0 schema is a single squashed **`0001_baseline.sql`** — greenfield had no production data, so the
historical build-up was collapsed into one baseline. To add schema after 1.0, add the next-numbered
`NNNN_name.sql` file — never edit an applied migration.

Spatial lookups use a plain lat/lon index (D1 does not support rtree virtual tables). Firehose positions are
TTL'd; the durable record is caches, finds, accounts, and keys — back those up.

## What the tables cover

The baseline groups into a handful of domains:

| Domain | Holds |
|--------|-------|
| **Caching** | Caches, logbook, ratings, favorites, staged/NFC unlocks, media, rendezvous, metadata & tags |
| **Positions & stations** | The live station registry, firehose positions, telemetry & weather readings, the recent-packet ring |
| **Accounts & identity** | Accounts, base callsigns, passkeys, device keys, callsign control-verification, profiles, preferences |
| **Verification** | Corroboration state and the corroborating-IGate credit |
| **Federation** | Mirrored remote caches/finds/keys, peers + trust + reputation, sync observability, tombstones, federation scope, account-moves, the relay queue |
| **BBS & node** | Store-and-forward mail, bulletins, threads, FBB forwarding partners/rules/log, White Pages, the NET/ROM node table |
| **Engagement** | Watchlists, saved map views, notifications, API keys, supporter recognition |

## Baseline and beyond

- `0001_baseline` establishes the whole 1.0 schema — caches, logs, positions, accounts, the workbench tables,
  federation, BBS/node, and engagement — with internal section headers preserving the original thematic order.
- Post-1.0 schema changes land as new `NNNN_name.sql` files applied on top of the baseline.

The typed data contracts that cross the wire — `Packet`, `Provenance`, the WebSocket messages, and the DTOs —
live in `@aprsweb/shared` (Zod schemas) and are the source of truth for request/response shapes.
