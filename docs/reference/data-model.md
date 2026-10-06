# Data model

The gateway's schema lives in **`db/migrations/`**. The Node, Bun and desktop servers' migration runner applies
the files there at boot, in name order, and tracks applied files by name in `_migrations`. Until 1.0 the schema
is one file, `0001_baseline.sql`, edited in place; once 1.0 is released that file is frozen and every schema
change is a new, next-numbered `NNNN_name.sql` file applied on top, never edited after it is applied.

The schema uses no virtual tables (rtree, FTS): spatial lookups use plain `(lat, lon)` indexes and search is
LIKE-based. Firehose positions and the diagnostic tables are TTL'd; the durable record is caches, finds,
accounts and keys — back those up.

## What the tables cover

The baseline is grouped into commented sections, one per domain:

| Domain | Holds |
|--------|-------|
| **Accounts & identity** | Accounts (active call, durable `account_id`, session generation, opt-in profile, the opt-in "you're near" radio message `near_radio`; the public profile and the email digest start off), held base calls, passkeys (each bound to the account that registered it, so it signs in from any call the account holds, `credentials.account_id`), an address given at passkey registration held unconfirmed until its link is opened (`accounts.pending_email`), one account per confirmed address, magic-link tokens, callsign history, UI preferences, the lifecycle ledger, recognition flags, read-API keys (each owned by an account and stored as its SHA-256 only) |
| **Callsign verification** | The single verification store (`callsign_verifications`), the in-session `ampr_dns` / `lotw` challenges, kept per starter so a claimant's and the holder's never replace each other (`callsign_challenges`), claims that take a call over from an account that has not proven control, each with a bearer token kept as its SHA-256 and its own on-air code (`callsign_claims`), the trail of every claim and sysop release (`callsign_events`), public licence-register validity, device signing keys |
| **Caches & finds** | Caches (with the source's attribution for imported places, `source_owner` and `source_attribution`, and the sysop's removal, `removed_at` and `removed_reason`), stages (with the sealed NFC reveal for offline packs, `sealed`, and the audio clue's size for the media limits, `media_bytes`) and unlocks, the coordinates pinned at a cache's first find (`cache_place_pins`), the logbook (tier, corroboration, the corroborating IGate, device signatures, when the log arrived and why its signed field time was refused, `received_at` and `field_time_rejected`, the time a find reached Tier A on a retry, `corroborated_later_at`, the "needs maintenance" flag; one `found` per logger and cache), the corroboration retry queue with the questions waiting at a hub's relay (`corroboration_retries`), ratings, media with their thumbnails (`thumb_key`, `thumb_bytes`), living-cache rendezvous, cache adoption, and imported places the sysop removed, which a re-import skips (`import_removals`) |
| **Community & notifications** | Achievements, favourites, watches, saved map views, the watchlist and its alerts, web-push subscriptions |
| **Stations, positions & weather** | Position history (every row records its `transport`, and the enrolled box that delivered it, `ingest_box`), the live station table, the raw-packet ring, the message log (each row with the `transport` that carried it; a sent message with its number, when the instance heard its ack, the APRS-IS outbox row that carries it and when that row went out, `acked_at`, `outbox_id`, `sent_at`), port counters, weather readings, operated stations, PWS push keys; MeshCom as the operator's own node(s) heard it: the latest state of each node (`meshcom_nodes`, including the relays a node named in its latest message, `sent_via` — its plan, never the route taken), the links between nodes (`meshcom_links`) and the group chat, one row per message however many nodes heard it (`meshcom_group_messages`) — display only, never a trust input, pruned nightly |
| **Radio services, outbox & ingest boxes** | The APRS-IS / CWOP outbox, commands sent as radio messages, the Mailbox (messages held for a station until it is heard, `mailbox_messages`), what the "you're near" message sent, per base call and cache, for its daily and hourly limits (`near_cache_messages`), the remote-box command queue, box ownership, pairing codes and reported capabilities; enrolled ingest boxes: one-time enrollment codes, kept as SHA-256 with who created them (`box_enrollment_codes`), each box's Ed25519 public key with who enrolled and revoked it and whether it runs this instance's services, off by default (`box_keys`); the receiving sites the sysop trusts for Tier A beside `FIRST_PARTY_SITES`: added by site call (`trusted_sites`), or an enrolled box's sites while the box is enrolled and trusted (`box_trusted_sites`); no row, no trust |
| **BBS & packet node** | Store-and-forward mail and bulletins with threads and read state (moved the F6FBB way only, never over APRS), forward rules, White Pages (each entry `manual`, set by the operator, or `learned` from forwarded mail's R: headers), FBB partners (each marked for federation over FBB or not, `bbs_partners.federation`) and the forward log, the NET/ROM node table and MHeard |
| **Federation** | Peers (endpoints and where they came from, trust, pinned and accepted keys, the fingerprint a `FED_PEERS` entry pinned and the key it matched, the rotation records a hub hands on, the base callsign ARDC verified for a peer added over 44Net, by which the corroboration quorum counts one voice per operator, when corroboration promoted a peer on its own, how discovery heard of it, the keys and bulletins cursors, sync health), the registry high-water mark, applied versions, the relay queue, mirrored caches (with their origin's federation scope, so an `unlisted` cache stays off this map and offline packs), finds and keys, tombstones (with the version a sysop's removal of a cache covers, `up_to`, so a restored cache federates again), account moves; the counter per kind that numbers this instance's caches, finds, tombstones, account moves and callsign keys, never below the time in milliseconds, and the number each record took, which is its global id (`fed_seq`, `caches.fed_id`, the `fed_seq` columns); how far this instance holds each origin's caches, finds, tombstones and account moves, how far it read each neighbour's pages of an origin, and a generation that moves on when it forgets what it held of one (`fed_origin_marks`, `fed_read_positions`, `fed_mark_gen`); the records of an origin it knows it lacks and asks for one by one, and those it gave up on after a week, until the sysop marks them seen (`fed_origin_gaps`, `fed_gaps_given_up`); every mirrored record's frame as its origin signed it, so the instance passes it on (`fed_transit`); push-to-hub state: a spoke's push cursor per feed and its hub's status, and on a hub where each spoke's feeds stand (`fed_push_cursors`, `fed_hub_status`, `fed_submit_marks`); the packet-circuit pull's own per-peer cursors and its last session (`fed_packet_sync`) |
| **Moderation** | Reports players file against an item, with the reporter's account and call (`moderation_reports`); the audit log of every sysop action, with who, when, the target and the reason (`moderation_log`); suspended accounts with the reason, a category and an optional end (`account_suspensions`); the record a suspension leaves on each base call of an account erased while suspended, the call, the category and the end only, which refuses the call to every account until it ends (`callsign_suspensions`). None of it federates |
| **Shack tools** | The tool registries the Tools app lists, the instance's and each player's, with the key pinned for each (`tool_registries`), and the gateway's copies of their files (`tool_registry_files`) |
| **Operations** | The transparency ledger, durable rate-limit counters, the daily update check's last answer (`update_check`), the site settings the sysop sets in Instance admin (`site_settings`) |

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
