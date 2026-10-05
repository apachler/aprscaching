# Import heritage places

This page is for the sysop. It shows how to import places from other programs (summits, parks, castles,
islands) as caches on your instance.

Every imported place carries its source and a link back. Duplicates across sources collapse to the ham-radio
program's entry. Imported places show on your instance only: federation never shares them, and the GPX and KML
exports leave them out, because a GPX or KML file cannot carry a source's licence and credit. Running an import
again updates the places in place.

## Before you start

- The instance's `OPERATOR_SECRET`: an import is a sysop action, run from a script with the operator secret.
  The ingest secret does not run imports.
- The licence of each source you import (see [Licences of the sources](#licences-of-the-sources)), and the
  provider's permission where its terms ask for one.

## Import a source

Send one request per source to `POST /api/import/<source>`, from any machine:

```bash
curl -X POST https://your.instance/api/import/sota \
  -H "x-operator-secret: $OPERATOR_SECRET" -H "content-type: application/json" \
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

## Licences of the sources

Each source's own terms apply to its data on your instance. Read them before you import.

| Source | Licence or terms | What your instance does |
|---|---|---|
| `opencaching` | CC BY-NC-ND 3.0 DE (Opencaching.de); OKAPI asks that each cache show its `attribution_note` and link to the cache page | Keeps the owner's name and the attribution note, and shows both on the cache page with a link to the listing |
| `gcau` | CC BY-NC-SA 2.5; the GPX feed needs a signed-in account | Refused until you name it in `IMPORT_ALLOW`; the importer does not keep each owner's credit |
| `wwff` | The directory may not be reproduced without WWFF's prior permission | Refused until you name it in `IMPORT_ALLOW` |
| `iota` | Personal, non-commercial home use only | Refused until you name it in `IMPORT_ALLOW` |
| `osm` | ODbL: credit OpenStreetMap, and share a public derivative database under the same licence | Links each place to its OpenStreetMap node |
| `wikidata` | CC0 | Links each place to its Wikidata item |
| `sota`, `pota` | No stated licence; poll politely | Links each place to its programme page |
| `bunker`, `geojson` | The provider's own terms | Links each place where the data gives a link |

`GET /api/import`, with the same `x-operator-secret` header, lists every source and whether your instance may
import it. A source that needs permission answers `403` with what it needs; once the provider grants it, add
the source to `IMPORT_ALLOW` (for example `IMPORT_ALLOW=wwff`) and restart the gateway.

Each import request names your instance to the provider, with its address and `OPERATOR_EMAIL`, so the
provider can reach you.

## Check that it worked

The answer lists how many places were fetched, imported, updated, skipped and de-duplicated. The places then
show on the map; [Heritage places](../../play/cache-types/heritage.md) is what players see.

## Remove one place

A source can ask you to take a listing down. OpenCaching's terms let a cache's owner ask. Remove that one place
and keep the rest:

1. Open **Instance admin → Imported places**.
2. Type the code, title or listing reference, for example `OC1234`, and tap **Search**.
3. Optional: type why under **Reason for a removal**, for example who asked and when.
4. Tap **Remove** beside the place and confirm.

The place leaves your instance with its logs, ratings and media. Its source and listing reference stay under
**Removed listings**, and every later import of that source skips it. From a script, send
`DELETE /api/admin/imports/<id>` with the `x-operator-secret` header; `GET /api/admin/imports?q=OC1234` gives
the id.

## Next

- [A public instance's duties](../compliance/index.md): what a public instance owes the people who use it.
