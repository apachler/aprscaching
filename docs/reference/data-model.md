# Data model

The gateway's schema lives in **`db/migrations/`**: the baseline `0001_baseline.sql` plus the numbered
files applied on top of it, in order. The Node, Bun and desktop servers' migration runner applies them at boot
and tracks applied files by name in `_migrations`. A schema change is a new, next-numbered `NNNN_name.sql` file applied on top; an applied file
is never edited.

The schema uses no virtual tables (rtree, FTS): spatial lookups use plain `(lat, lon)` indexes and search is
LIKE-based. Firehose positions and the diagnostic tables are TTL'd; the durable record is caches, finds,
accounts and keys — back those up.

## What the tables cover

The baseline is grouped into commented sections, one per domain; the later migrations extend the domains
as noted:

| Domain | Holds |
|--------|-------|
| **Accounts & identity** | Accounts (active call, durable `account_id`, session generation, opt-in profile), held base calls, passkeys, magic-link tokens, callsign history, UI preferences, the lifecycle ledger, recognition flags, read-API keys (each owned by an account and stored as its SHA-256 only, `0031`); each passkey bound to the account that registered it, so it signs in from any call the account holds (`credentials.account_id`), and an address given at passkey registration held unconfirmed until its link is opened (`accounts.pending_email`), with one account per confirmed address (`0021`) |
| **Callsign verification** | The single verification store (`callsign_verifications`), the in-session `ampr_dns` / `lotw` challenges, public licence-register validity, device signing keys; the receiving sites the sysop trusts for Tier A beside `FIRST_PARTY_SITES`: added by site call (`trusted_sites`), or an enrolled box's sites while the box is enrolled and trusted (`box_trusted_sites`); no row, no trust (`0017`); claims that take a call over from an account that has not proven control, each with a bearer token kept as its SHA-256 and its own on-air code (`callsign_claims`), the trail of every claim and sysop release (`callsign_events`), and the browser-session challenges kept per starter, so a claimant's and the holder's never replace each other (`callsign_challenges`) (`0026`) |
| **Caches & finds** | Caches (with the federation revision trigger), stages and unlocks, the logbook (tier, corroboration, the corroborating IGate, device signatures; one `found` per logger and cache), ratings, media, living-cache rendezvous, cache adoption; the corroboration retry queue (`corroboration_retries`) and the time a find reached Tier A later (`cache_logs.corroborated_later_at`) (`0003`); the questions it waits for at a hub's relay (`corroboration_retries.relayed`, `0041`); when the instance received a log and, when its time is that arrival rather than its signed field time, why (`cache_logs.received_at`, `field_time_rejected`) (`0008`); the thumbnail stored beside a cache image (`cache_media.thumb_key`, `thumb_bytes`) (`0010`); what an NFC stage reveals, sealed under its tag code for offline packs (`cache_stages.sealed`) (`0011`); the size of a stage's audio clue, so the per-cache, per-account and per-instance media limits count it (`cache_stages.media_bytes`, `0016`); what an imported place's source asks to be shown with it: the author's name there and the source's attribution note as text parts with optional links (`caches.source_owner`, `source_attribution`; `NULL` for native caches, `0023`) |
| **Community & notifications** | Achievements, favourites, watches, saved map views, the watchlist and its alerts, web-push subscriptions |
| **Stations, positions & weather** | Position history (every row records its `transport`, and the enrolled box that delivered it, `ingest_box`, `0022`), the live station table, the raw-packet ring, the message log (each row with the `transport` that carried it, `0018`; a sent message with its number, when the instance heard its ack, the APRS-IS outbox row that carries it and when that row went out, `messages.acked_at`, `outbox_id`, `sent_at`, `0033`), port counters, weather readings, operated stations, PWS push keys |
| **Radio commands, outbox & remote boxes** | The APRS-IS / CWOP outbox, commands sent as radio messages, the Mailbox (messages held for a station until it is heard, with their delivery state, `mailbox_messages`, `0014`), the remote-box command queue, box ownership, pairing codes and reported capabilities; enrolled ingest boxes: one-time enrollment codes, kept as SHA-256 with who created them (`box_enrollment_codes`), and each box's Ed25519 public key with who enrolled and revoked it (`box_keys`) (`0007`), and whether the box runs this instance's services (BBS mailbox, FBB forwarding, the NET/ROM mirror, White Pages, federation frames, the APRS-IS outbox, box TX commands), off by default (`box_keys.services`, `0022`); the opt-in "you're near" radio message (`accounts.near_radio`, off by default) and what it sent, per base call and cache, for its daily and hourly limits, pruned nightly (`near_cache_messages`, `0015`) |
| **BBS & packet node** | Store-and-forward mail and bulletins with threads and read state, forward rules, White Pages (each entry `manual`, set by the operator, or `learned` from forwarded mail's R: headers, `0019`), FBB partners (each marked for federation over FBB or not, `bbs_partners.federation`, `0038`) and the forward log, the NET/ROM node table and MHeard; the BBS moves mail the F6FBB way only and keeps no APRS delivery state (`0013`) |
| **Federation** | Peers (endpoints, trust, pinned and accepted keys, the keys and bulletins cursors, sync health), the registry high-water mark, applied versions, the relay queue, mirrored caches/finds/keys, tombstones, account moves; the base callsign ARDC verified for a peer added over 44Net, by which the corroboration quorum counts one voice per operator (`fed_peers.operator_call`, `0005`); push-to-hub state: a spoke's push cursor per feed and its hub's status (`fed_push_cursors`, `fed_hub_status`), and on a hub where each spoke's feeds stand (`fed_submit_marks`) (`0009`); a mirrored cache keeps its origin's federation scope, so an `unlisted` cache stays off this map and offline packs (`remote_caches.fed_scope`, `0012`); where a peer's endpoint set came from (`fed_peers.endpoints_source`: DNS, its descriptor or a beacon), the key a `FED_PEERS` fingerprint pin matched (`pin_matched_key`), when corroboration promoted a peer on its own (`auto_promoted_at`), and the version a sysop's removal of a cache covers, so a restored cache federates again (`tombstones.up_to`, `remote_tombstones.up_to`) (`0036`); every mirrored cache, find, tombstone and account move's frame as its origin signed it, with who delivered it and how many instances it crossed, so the instance passes it on (`fed_transit`), and the rotation records a hub hands on with a peer's key (`fed_peers.rotations`) (`0039`); the packet-circuit pull's own per-peer cursors and its last session (`fed_packet_sync`, `0040`); how far this instance holds each origin's caches, finds, tombstones and account moves, with the `FED_SYNC_REGION` a caches mark was read under, how far it read each neighbour's pages of an origin, and a generation that moves on when it forgets what it held of one (`fed_origin_marks`, `fed_read_positions`, `fed_mark_gen`); the counter per kind that numbers this instance's caches, finds, tombstones and account moves, never below the time in milliseconds, and the number each find, tombstone and account move took (`fed_seq`, `cache_logs.fed_seq`, `tombstones.fed_seq`, `account_moves.fed_seq`) (`0043`); how discovery heard of a peer, each source with the fingerprint it gave, and the newest sighting, by which a listing expires (`fed_peers.discovered`, `listed_at`, `0044`) |
| **MeshCom** | The latest state of each MeshCom node the operator's own node(s) heard (`meshcom_nodes`, including the relays a node named in its latest message, `sent_via` — its plan, never the route taken — and when that message was seen, `msg_at`) and the links between nodes (`meshcom_links`, direct or each leg of a relay path) — display only, never a trust input, pruned nightly (`0004`, `0006`); the group chat the node(s) heard, one row per message however many nodes heard it (`meshcom_group_messages`), pruned with the message log (`0018`) |
| **Operations** | The transparency ledger, durable rate-limit counters |
| **Moderation** | Reports players file against an item, with the reporter's account and call (`moderation_reports`); the audit log of every sysop action, with who, when, the target and the reason (`moderation_log`); suspended accounts with the reason, a category and an optional end (`account_suspensions`); the record a
suspension leaves on each base call of an account erased while suspended, the call, the category and the end only,
which refuses the call to every account until it ends (`callsign_suspensions`, `0035`); a cache the sysop removed, archived and hidden from everyone but its owner and the sysop (`caches.removed_at`, `removed_reason`) (`0025`). None of it federates |

`positions.transport` is how a position reached the gateway (`aprs-is`, `tnc`, `browser-rf`, `axudp`,
`axip`, `meshcom`, `meshtastic`, or `unknown` for an ingest port the gateway does not know), derived from
the ingest port. It is display and statistics data: the verify engine never branches on it, and only the
on-air transports can carry first-party attestation.

Delete tombstones (`tombstones`, `remote_tombstones`) are kept permanently. They hold only PII-free global
ids, and a mirror consults them on every upsert so deleted data is never re-mirrored.

The moderation tables stay on the instance. The audit log is kept as the instance's record of what was done
and why; a person's export carries the rows about their account, and their erasure removes them as the reporter
of the reports they filed ([Moderation](../run/day-to-day/moderation.md)).

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

## Next

- [HTTP API](api.md): the endpoints over these tables.
- [Backups and moving](../run/day-to-day/backups.md): what to back up.
