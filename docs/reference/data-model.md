# Data model

The gateway's schema lives in **`db/migrations/`**: the baseline `0001_baseline.sql` plus the numbered
files applied on top of it, in order, identically on every runtime: `wrangler d1 migrations apply` on D1 (`migrations_dir` in `workers/gateway/wrangler.toml`), and the
Node, Bun and desktop servers' migration runner at boot, which tracks applied files by name in
`_migrations`. A schema change is a new, next-numbered `NNNN_name.sql` file applied on top; an applied file
is never edited.

D1 forbids virtual tables (rtree, FTS), so spatial lookups use plain `(lat, lon)` indexes and search is
LIKE-based. Firehose positions and the diagnostic tables are TTL'd; the durable record is caches, finds,
accounts and keys — back those up.

## What the tables cover

The baseline is grouped into commented sections, one per domain; the later migrations extend the domains
as noted:

| Domain | Holds |
|--------|-------|
| **Accounts & identity** | Accounts (active call, durable `account_id`, session generation, opt-in profile), held base calls, passkeys, magic-link tokens, callsign history, UI preferences, the lifecycle ledger, recognition flags, API keys |
| **Callsign verification** | The single verification store (`callsign_verifications`), the in-session `ampr_dns` / `lotw` challenges, public licence-register validity, device signing keys |
| **Caches & finds** | Caches (with the federation revision trigger), stages and unlocks, the logbook (tier, corroboration, the corroborating IGate, device signatures; one `found` per logger and cache), ratings, media, living-cache rendezvous, cache adoption; the corroboration retry queue (`corroboration_retries`) and the time a find reached Tier A later (`cache_logs.corroborated_later_at`) (`0003`) |
| **Community & notifications** | Achievements, favourites, watches, saved map views, the watchlist and its alerts, web-push subscriptions |
| **Stations, positions & weather** | Position history (every row records its `transport`), the live station table, the raw-packet ring, the message log, port counters, weather readings, operated stations, PWS push keys |
| **Radio commands, outbox & remote boxes** | The APRS-IS / CWOP outbox, commands sent as radio messages, the remote-box command queue, box ownership, pairing codes and reported capabilities |
| **BBS & packet node** | Store-and-forward mail and bulletins with threads, delivery state, forward rules, White Pages, FBB partners and the forward log, the NET/ROM node table and MHeard |
| **Federation** | Peers (endpoints, trust, pinned and accepted keys, per-feed cursors, sync health), the registry high-water mark, applied versions, the relay queue, mirrored caches/finds/keys, tombstones, account moves; the region a peer's caches cursor was read under, so a change of `FED_SYNC_REGION` reads the feed again (`fed_peers.caches_region`, `0002`), and the base callsign ARDC verified for a peer added over 44Net, by which the corroboration quorum counts one voice per operator (`fed_peers.operator_call`, `0005`) |
| **MeshCom map** | The latest state of each MeshCom node the operator's own node(s) heard (`meshcom_nodes`, including the relays a node named in its latest message, `sent_via` — its plan, never the route taken — and when that message was seen, `msg_at`) and the links between nodes (`meshcom_links`, direct or each leg of a relay path) — display only, never a trust input, pruned nightly (`0004`, `0006`) |
| **Operations** | The transparency ledger, durable rate-limit counters |

`positions.transport` is how a position reached the gateway (`aprs-is`, `tnc`, `browser-rf`, `axudp`,
`axip`, `meshcom`, `meshtastic`, or `unknown` for an ingest port the gateway does not know), derived from
the ingest port. It is display and statistics data: the verify engine never branches on it, and only the
on-air transports can carry first-party attestation.

Delete tombstones (`tombstones`, `remote_tombstones`) are kept permanently. They hold only PII-free global
ids, and a mirror consults them on every upsert so deleted data is never re-mirrored.

## Identity: who holds a call, and whether it is verified

Two tables answer the two identity questions, and nothing else stores either answer:

- **Who holds a licence** — `account_callsigns`, one row per held base call (no SSID), at most one account
  per base call. Every account holds the base call of its active call (`accounts.callsign`); a session,
  cache ownership and device-key registration all resolve through it.
- **Whether control is proven** — `callsign_verifications`, keyed by base call, `status = 'verified'`, with
  the method, who vouched and when. The session's `verified`, the held-call list, device keys (and the
  key feed peers mirror), transmitting, the sysop role and the GDPR export all derive the flag from it,
  so a verification or a revocation shows everywhere at once. Every SSID inherits its base call's state.
  Claiming a base call nobody held clears any verification recorded for it, so a claim starts unverified.

`callsign_history.verified` is a history record — whether the call was verified when the account
switched to it — not a live flag.

The typed data contracts that cross the wire — `Packet`, `Provenance`, the WebSocket messages, and the DTOs —
live in `@aprscaching/shared` (Zod schemas) and are the source of truth for request/response shapes.
