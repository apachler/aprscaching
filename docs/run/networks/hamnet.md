# HAMNET only

This page lists what an instance can still do when it has no internet path: a 44.x instance reached over
HAMNET, or an [off-grid](off-grid.md) box on a LAN. It is for the sysop. The instance runs, but everything
that calls a service on the internet stops; the table names each one and its workaround.

## What works, and the workarounds

| Feature | Works without the internet? | Workaround |
|---------|--------------------|------------|
| The app itself: scripts, styles, fonts, the MapLibre worker | Yes | Bundled and served by the instance; nothing loads from a CDN |
| Base map, *Dark*, *Light* and *Auto* themes (default OpenFreeMap vector style) | No | Build the web app with `VITE_BASEMAP=offline` (the self-contained grid), use the *Phosphor* theme (its grid is built in), or point `VITE_BASEMAP_STYLE` at a style served inside HAMNET. While the online style cannot load, the map fetches caches only after the first pan or zoom |
| Map tiles for hunters in the field | Yes, with an offline map | Serve an [offline map](../install/offline-map.md): the instance hands out its own PMTiles archive, hunters make offline packs from it over HAMNET, and the app draws a pack's map when it is offline |
| Topo and satellite layers (OpenTopoMap, EOX) | No | Stay on the vector or offline base map; both layers are opt-in |
| "Navigate" links (Google Maps, Apple Maps, OpenStreetMap) | No | They are plain links; the cache's coordinates stay on the sheet |
| Embeddable map widget (`/embed`) | Works with `BASEMAP_STYLE=offline` or a HAMNET style | MapLibre comes from the instance's own web build. The base map is the gateway's `BASEMAP_STYLE`: `offline` draws the self-contained grid, or point it at a style served inside HAMNET ([configuration](../../reference/configuration.md#gateway-read-api-spots-emailpush)) |
| Passkeys, device location (Tier B finds), Web Serial / Web Bluetooth radio, web push | Only over https | [TLS on the 44Net name](44net-identity.md#tls-on-the-44net-name). Over plain http, members sign in with the sysop's [one-time link](../day-to-day/sign-in-links.md#off-grid-sign-in) and log finds unsigned |
| Email sign-in links and the watch digest | Only with an SMTP server reachable on HAMNET; the Resend API needs the internet | Set `SMTP_HOST` to a mail server inside HAMNET ([Send mail](../day-to-day/mail.md)), or use passkeys or the sysop's one-time link |
| Web push delivery (the browser vendor's push service) | No | The in-app watchlist |
| APRS-IS feed and uplink (`rotate.aprs2.net` by default) | No | Set `APRSIS_HOST` to an APRS-IS server reachable on HAMNET, if your region runs one (**Unverified** per region). RF from your own TNC is unaffected |
| RF ingest from your own radio | Yes | The [off-grid](off-grid.md) shape: the ingest box and a local gateway on one machine, `INGEST_URL=http://localhost:8787/ingest` |
| Federation with https peers on the internet | No | Peers with a `44net` endpoint reachable over HAMNET (**Unverified**, see [below](#hamnet-and-44net-connect)); packet carriers (AX.25, NET/ROM, FBB) need no IP at all ([wire format](../../reference/federation-wire.md)). Discovery learns only https peers |
| Adding a peer by callsign, `ampr.org` callsign verification, the 44Net self-check | No, with the default resolvers | Set `DOH_URL` (and `AMPR_DNS_RESOLVERS`) to DNS-over-HTTPS resolvers reachable on HAMNET that can still reach ARDC's name servers; otherwise do these while connected. Verification over RF works offline |
| Instance registry located by `FED_REGISTRY_DNS` | No | This lookup always asks Cloudflare's resolver and ignores `DOH_URL`. Set `FED_REGISTRY` to a document URL reachable on HAMNET instead; the last good document keeps binding meanwhile |
| Source link (`/source` → `SOURCE_REPO`, GitHub by default) | The link works, the target doesn't | Point `SOURCE_REPO` at a mirror reachable on HAMNET: any forge with `<repo>/tree/<commit>` URLs (AGPL §13) |
| Activity spots, licence-register refresh, heritage and OpenCaching imports | No | Optional; they resume when a path to the internet returns |

## HAMNET and 44Net Connect

HAMNET is a separate amateur IP backbone, mostly `44.128.0.0/10` and not announced to the internet. ARDC:
"A subnet reachable via Connect is not automatically part of the Mesh. A Mesh network does not automatically
appear via BGP." ([Decentralization](https://wiki.ampr.org/wiki/Decentralization), checked 2026-09-30).
Whether a HAMNET station can reach a Connect address, and the other way round, is **Unverified**: it
depends on the regional HAMNET gateway, and a test from a HAMNET station settles it for your region.

## Next

- [Join the network](../federation/index.md): peers, trust and running federation safely.
- [Off-grid and LAN](off-grid.md): run the whole instance on one box with no internet.
