# Import heritage places

This page is for the sysop. It shows how to import places from other programs (summits, parks, castles,
islands) as caches on your instance.

Every imported place carries its source and a link back. Duplicates across sources collapse to the ham-radio
program's entry, and imported places never leave your instance. Running an import again updates the places in
place.

## Before you start

- The instance's `INGEST_SECRET`: the importer is part of the ingest plane, so any machine that knows the
  secret can run an import.
- The licence of each source you import. OpenCaching content in particular carries conditions (see `TODO.md`).

## Import a source

Send one request per source to `POST /api/import/<source>`, from any machine:

```bash
curl -X POST https://your.instance/api/import/sota \
  -H "x-ingest-secret: $INGEST_SECRET" -H "content-type: application/json" \
  -d '{"region":"OE/ST"}'
```

The body says what to import:

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

## Check that it worked

The answer lists how many places were fetched, imported, updated, skipped and de-duplicated. The places then
show on the map; [Heritage places](../../play/cache-types/heritage.md) is what players see.

## Next

- [A public instance's duties](../compliance/index.md): what a public instance owes the people who use it.
