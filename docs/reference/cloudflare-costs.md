# Cloudflare D1 costs

Reference for the [Cloudflare split](../operate/deployment.md#cloudflare-split) deployment: what D1 bills, how
much a feed writes, and the write budget that caps it. Self-host and Desktop store in SQLite on your own disk
and have no per-row cost.

## Cost on D1

D1 bills **rows written**, and on this shape every packet your ingest forwards is written to D1. The cost
therefore scales with your APRS-IS filter and your RF traffic, not with your users. A self-hosted SQLite
database has no such meter: its cost is flat whatever the feed.

D1 counts each row an `INSERT`, `UPDATE` or `DELETE` writes, plus one row for each index entry an insert or
update writes. Cloudflare's price list ([D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/), checked
2026-09-30):

| Plan | Rows written included | Beyond that |
|------|-----------------------|-------------|
| Workers Free | 100,000 per day (D1 queries fail once it is used up, until 00:00 UTC) | — |
| Workers Paid ($5 per month minimum) | 50 million per month | $1.00 per million |

**Rows written per packet.** The gateway's test suite pins these values, measured with the `rows_written`
counter of workerd's local D1 (`workers/gateway/test/d1_writes.test.ts`). They are the steady state: a station
and port already heard.

The gateway stores a position fix only when it says something new: the station has moved at least
`POS_MIN_MOVE_M` (25 m) since its last stored fix, or `POS_MIN_INTERVAL_S` (10 min) has passed. Every fix of a
**protected** station is stored, because verification reads them: a call an account holds or has verified
(any SSID), a registered station, a call with a find open (a find logged or a radio command sent in the last
30 minutes, or a radio command still pending), and the station of a living cache. So is every fix heard
directly on RF by your own TNC or MeshCom node, whatever the callsign. A fix that is not stored still reaches
the live map, watch alerts and rendezvous. A station that has not moved leaves its map position and registry
entry unrewritten.

| Packet | Written on ingest | Written by the nightly prune | Total |
|--------|-------------------|------------------------------|-------|
| Position fix, not stored (a station nothing protects that has not moved) | 6 | 1 | 7 |
| Position fix, stored, the station has not moved (protected, heard on RF, or the interval passed) | 11 | 2 | 13 |
| Position fix, stored, the station has moved | 12 | 2 | 14 |
| Position fix of a registered station that has moved | 13 | 2 | 15 |
| Position fix of a registered station that has not moved | 11 | 2 | 13 |
| Weather report with a position, not stored | 8 | 2 | 10 |
| Weather report with a position, stored | 13–14 | 3 | 16–17 |
| Weather report without a position | 8 | 2 | 10 |
| Message | 9 | 2 | 11 |
| Status, telemetry, anything else | 6 | 1 | 7 |

Every packet writes its row in the raw-packet ring (4 rows: the row, two indexes and the ID counter) and
its MHeard entry (2; a station heard several times in one batch writes it once). A stored position fix adds
the position history (4) and the station's latest position (1 when it has not moved, 2 when the position
index changes too). A station heard for the first time costs 2 more. On top of the per-packet rows, each
ingest batch adds 1 row per port for the hourly RX counter. The ingest posts a batch every 1.5 s
(`BATCH_MS`), so this adds at most 57,600 rows per day for each port. The nightly prune writes 1 row for each
row it deletes.

**Rows per day and per month.** The table below assumes a typical feed: 65 % position fixes, 10 % weather
with a position, 2 % weather without one, 3 % messages and 20 % other packets. It also assumes that half of
the position and weather fixes are not stored. A busy APRS-IS feed is mostly stations nothing protects —
digipeaters, IGates, weather stations, parked trackers — and many of them beacon from the same spot more
often than every 10 minutes; the protected stations (your own members and their finds) are a small share of
it. Your feed may thin more or less than that: a station beaconing every 10 minutes or slower is always
stored. The assumptions come to about 10 rows written per packet, counter rows and prune included; storing
every fix (`0`) makes it about 12. The table covers the ingest only; sign-ins, finds and federation add their
own writes on top.

| Feed | Packets per day | Rows written per day | Rows written per 30 days | Workers Free | Workers Paid per month |
|------|-----------------|----------------------|--------------------------|--------------|------------------------|
| 0.1 packets/s | 8,640 | ~96,000 | ~2.9 million | at the daily limit | $5 |
| 0.5 packets/s | 43,200 | ~480,000 | ~14 million | over | $5 |
| 1 packet/s | 86,400 | ~930,000 | ~28 million | over | $5 |
| 2 packets/s (the default filter, assumed) | 172,800 | ~1.8 million | ~54 million | over | ~$9 |
| 5 packets/s | 432,000 | ~4.4 million | ~133 million | over | ~$88 |
| 20 packets/s | 1.7 million | ~17.5 million | ~526 million | over | ~$481 |

The Free plan fits a feed of up to about 0.1 packets/s (about 9,000 packets a day): a single RF port or a
very small filter. Workers Paid covers about 1.8 packets/s within its included 50 million rows; every
further packet per second costs about $26 a month. Raising `POS_MIN_INTERVAL_S` or `POS_MIN_MOVE_M` thins
the unprotected stations further; `0` in either stores every fix.

The default filter in `.env.example`, `r/47.07/15.42/300`, is every station within 300 km of Graz. Its rate
in the table above is an assumption, not a measurement. Measure your own feed: `GET /api/ports` returns
each port's received packets over the last 24 hours (`{"window":"24h","ports":[{"port":"aprs-is","rx":…}]}`);
divide `rx` by 86,400 for packets per second. The Cloudflare dashboard (**D1 → your database → Metrics**)
shows the rows actually written.

This shape suits a small regional feed and an operator who wants no server to maintain. A large or
global feed belongs on [Self-host](../operate/deployment.md#self-host), where the cost is flat.

## Write budget

The Worker keeps a daily budget of D1 rows written, `D1_DAILY_WRITE_BUDGET`: **1,500,000** by default (the
Workers Paid allowance of 50 million a month, spread over 30 days). On Workers Free set it to **90000**, which
leaves a margin under the 100,000-row daily limit for sign-ins and finds. `0` turns the guard off. The count
covers every write the gateway makes, the nightly prune included, and starts again at 00:00 UTC, when
Cloudflare's own daily limits reset.

As the day's count nears the budget, the gateway stops storing the writes that matter least:

| Level | From | What is no longer stored |
|-------|------|--------------------------|
| ok | — | nothing: everything is stored as configured |
| warn | 80 % | the raw packet log (`packets_recent`), so the shack's raw packet view goes quiet (the Setup checklist's "Ingest feeding" line says why); a stationary station nothing protects stores a fix every `POS_MIN_INTERVAL_S` × 6 (an hour by default) instead of every interval, so its last-heard time can trail by that much |
| over | 100 % | also every fix and station update of a station nothing protects heard over APRS-IS, weather readings, messages that no protected call sends or receives, MHeard entries of stations your own receiver did not hear, and the hourly port counters |

**Protected data is never throttled.** At every level the gateway stores every fix of a protected station and
every fix heard directly on RF, every find and radio command (the message to the service call is still read as
a command and kept), a message to or from a protected call, account and key data, watch alerts, and
everything federation brings in, tombstones included. The nightly prune runs whatever the level: its deletes
count toward the budget, but it only ever shrinks the tables. A fix that is not stored still reaches the live
map, watch alerts and rendezvous.

The sysop hears about each threshold once per UTC day: a banner at the top of **Instance admin** (with the
count, which the Setup checklist's "D1 write budget" line also shows every day), and a line in the nightly
email digest to the address of every account that holds a control-verified `ADMIN_CALLSIGNS` call, when
email is configured. `GET /api/admin/setup` returns the same `budget: { used, budget, level, alerts }`
(sysop only).

The counter lives in the live-map Durable Object, which every Worker isolate shares, so reading the level
costs no D1 query: the ingest hands each batch's written rows to it with the live dispatch it already sends,
and gets the level back for the next batch. The object keeps the day's total in memory and writes it to its
own storage at most once a minute, plus once for each alert raised or mailed: at most about 1,440 storage
writes a day. SQLite-backed Durable Object storage is billed apart from D1, at the same rates (Workers Paid:
50 million rows written a month included, then $1.00 per million; Workers Free: 100,000 a day —
[Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/), checked
2026-09-30), so the counter's own writes are negligible. When the object restarts it resumes from the last
stored total and may miss up to a minute of writes. On the Node and Bun runtimes the guard is off unless
`D1_DAILY_WRITE_BUDGET` is set; there the count is kept in memory, starts again when the server restarts, and
counts changed rows only (SQLite reports no index rows), so it runs low.
