# Administration

Some configuration governs the **whole instance** and belongs to the ham who deployed it — not to platform
users. This surface is separate from per-user settings and is gated server-side.

## Operator identity

`ADMIN_CALLSIGNS` (comma-separated licensed calls) names the instance operator(s). A signed-in account whose
active callsign is in that list is a **sysop**; `GET /api/admin/whoami` tells the web app whether to reveal
the operator surface. Every operator write is enforced by `requireSysop` on the server — hiding a control in
the UI is never the gate. If `ADMIN_CALLSIGNS` is unset, the web operator surface is locked entirely (the
operator-local ingest box can still act with `INGEST_SECRET`).

!!! warning
    `ADMIN_CALLSIGNS` is security-critical and env-only — it must never be settable at runtime. It works
    identically on every runtime (Worker, Node, Bun): the self-host servers forward the complete config-key
    set into the gateway, so each topology has the web sysop surface when the variable is set.

## Operator-only surfaces

Reached from the instance-admin panel (shown only to operators):

- **Federation** — the peer list with health and reputation, per-peer **trust** (`trusted` / `unvetted` /
  `blocked`), and a manual sync trigger. See [Federation](../guides/federation.md).
- **FBB forwarding** — partner BBSes (callsign, protocol, intervals, time-bands, message types) and
  hierarchical routing rules, plus the White Pages directory that steers personal mail.
- **NET/ROM node** — the learned NODES routing table.
- **Ingest & transports** — the data plane (transports and the TAK/CoT feed). `GET /api/cot?bbox=` renders
  the live station registry as Cursor-on-Target for ATAK / WinTAK / iTAK.

Everything a normal user does — hiding and logging caches, favorites and ratings, callsign management,
preferences, media, enabling tools, and their own data actions — is **not** on this surface.

## Import heritage places

Places from other programs — summits, parks, castles, islands — can be imported as caches. An import runs
on request, from any machine that knows the instance's `INGEST_SECRET`; running it again updates the
places in place. Every place carries its source and a link back, duplicates across sources collapse to
the ham-radio program's entry, and imported places never leave your instance.

```bash
curl -X POST https://your.instance/api/import/sota \
  -H "x-ingest-secret: $INGEST_SECRET" -H "content-type: application/json" \
  -d '{"region":"OE/ST"}'
```

The answer lists how many places were fetched, imported, updated, skipped and de-duplicated.

| Source | Body | Example |
|---|---|---|
| `sota` | `region` = association/region | `{"region":"OE/ST"}` |
| `pota` | `region` = POTA location (all parks when empty) | `{"region":"US-NY"}` |
| `wwff` | `region` = programme | `{"region":"OEFF"}` |
| `iota` | `region` = reference prefix | `{"region":"EU"}` |
| `bunker` (WWBOTA/UKBOTA) | `bbox` = `[minLon,minLat,maxLon,maxLat]` | `{"bbox":[13,46.5,16,48]}` |
| `gcau` (Geocaching Australia) | `region` = state | `{"region":"vic"}` |
| `opencaching` | `bbox`, plus `url` + `key` of the node (or `OKAPI_BASE` + `OKAPI_KEY`) | `{"bbox":[13,46.5,16,48]}` |
| `osm` | `bbox`, `region` = OSM tag (default `natural=peak`) | `{"bbox":[13,46.5,16,48],"region":"historic=castle"}` |
| `wikidata` | `region` = class (default `Q8502` mountain; `Q23413` castle, `Q39715` lighthouse), optional `bbox`, `limit` | `{"region":"Q23413","bbox":[13,46.5,16,48]}` |
| `geojson` | `url` of a GeoJSON file, optional `sourceName`, `type`, `deepLink` | `{"url":"https://example.org/castles.geojson"}` |

Respect each source's licence; OpenCaching content in particular carries conditions (see `TODO.md`).

## Remote control of your box

You can drive your own ingest box from the web app without opening any inbound port: the app enqueues
commands and the box pulls them over its existing outbound connection (`/api/box/:id/*`). Read-only commands
need only a session; any transmit command requires a **verified callsign**.

## Data protection (GDPR / DSGVO)

Sensitive account actions are authorised by a passkey session or a signature from a device key registered to
the callsign — there is no central password.

- **Export** (`POST /api/account/:call/export`) returns a full machine-readable copy of the account's data.
- **Erase** (`/delete`) anonymises finds to `WITHDRAWN`, archives owned caches, deletes personal rows, and
  emits a **PII-free tombstone** so federation peers purge their mirrored copies.
- **Portability** (`/bundle`, `/move`, `/api/account/import`) lets a user migrate a callsign to another
  instance; because finds are device-signed, history stays attributable, and an account-move record
  re-points attribution across the network.

Positions are TTL'd; the retained record is public ham identifiers and APRS positions that are public by
design on RF/APRS-IS. Set `TOMBSTONE_TTL_DAYS` for how long deletes are retained for peer convergence.
