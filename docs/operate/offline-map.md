# The offline map

Hunters make **offline packs** before a trip without signal ([Offline packs](../guides/caching.md)). A pack
always holds the caches; if your instance offers an **offline map**, it holds the map of its square too, and the
app draws it with no connection. Without one, the offline map is a grid under the caches.

The offline map is one file you provide: a regional **PMTiles** archive of vector tiles, cut from
OpenStreetMap data. Your instance serves it; a phone reads only the tiles of its pack's square, by byte range.
No tiles come from a third-party tile service: OpenStreetMap's own tile servers forbid bulk and offline
downloads.

## Prepare the archive

Cut your region from a [Protomaps](https://protomaps.com) daily build with the
[`pmtiles` command-line tool](https://docs.protomaps.com/pmtiles/cli):

```bash
pmtiles extract https://build.protomaps.com/20261001.pmtiles austria.pmtiles \
  --bbox=9.5,46.3,17.2,49.1 --maxzoom=14
```

Name a recent build date (the [builds](https://maps.protomaps.com/builds/) page lists them). Zoom 14 shows
paths and buildings; a country of Austria's size at zoom 14 is a few hundred MB on the server. A pack takes
only its own square, and stops at the zoom that fits its 250 MB limit (it says so). The app draws the
Protomaps basemap layers (land, land cover and use, water, roads and paths, buildings, boundaries) without
labels: place and street names need font files a pack does not hold.

**Licence.** The data is © OpenStreetMap contributors under the
[ODbL](https://www.openstreetmap.org/copyright); the app shows the attribution on the offline map. Refresh
the archive now and then: a pack keeps the map it was made with, until it is made again.

## Configure it

| Shape | How |
|---|---|
| Self-host (Docker) | Put the file in the data volume, e.g. `docker compose cp austria.pmtiles gateway:/data/offline.pmtiles`, and set `OFFLINE_TILES_PATH=/data/offline.pmtiles` in `.env`. |
| Bare metal, Pocket, Desktop | Set `OFFLINE_TILES_PATH` to the file's path. |
| Cloudflare split | Upload it to the `TILES` bucket: `wrangler r2 object put aprscaching-assets/offline.pmtiles --file austria.pmtiles` (`OFFLINE_TILES_KEY` names another key). |
| Hosted elsewhere | Set `OFFLINE_TILES_URL` to its URL. The host must allow offline use and answer byte ranges with CORS (`Access-Control-Allow-Origin`, and `Content-Range` exposed). |

The instance serves the file at `/tiles/offline.pmtiles`; `GET /api/offline/tiles` tells the app where it is.
`OFFLINE_TILES_ATTRIBUTION` replaces the default `© OpenStreetMap contributors` (credit Protomaps too if you
like), and `OFFLINE_TILES_MAXZOOM` (default `14`) caps how deep a pack goes. A replaced file is served at
once, with no restart. [Configuration](../reference/configuration.md) lists every key.

On Pocket, the phone serves the archive on its hotspot, so a group of hunters on it makes packs with no
internet at all.
