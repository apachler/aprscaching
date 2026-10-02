# Hide a cache

This page is for hiders: how to place a cache, who sees it, and how to hand it on.

1. Tap **+ Hide a cache** (phone: **Hide**). You need to be signed in.
2. Place the pin. On a phone it starts at your location; otherwise tap or click the map where the cache is,
   or tap **Use my location**. Drag the pin to adjust.
3. Fill in **Title** and **Type** (the line under the type says what it means); set **Difficulty & terrain**
   with the sliders.
4. Under **Advanced**, optionally: **Hint**, **Description**, **Drive-in**, **Country**, **Tags**, and
   **Rating & federation** — who may rate it, and the scope —
   - **Public** — shared with linked instances;
   - **Unlisted** — listed here as usual; linked instances get its title and position, not its description;
   - **Local only** — stays on this instance. The hint is never shared.
5. Tap **Hide cache**. It gets a code like `AC-1234`.

Add photos afterwards from the cache's **Media** section. The app scales a photo to at most 1600 pixels before it uploads and stores a small thumbnail beside it, so the gallery and offline packs load little. A **Living (APRS)** cache asks for the station
callsign it follows; you can also create one from **Settings → My stations**.

The hide form does not set a cache's stages or raise its minimum tier. Both are owner updates through the
[HTTP API](../reference/api.md) (`PATCH /api/caches/:id`, `POST /api/caches/:id/stages`); if you don't use
the API, ask the instance's sysop.

## Adopt a cache

When a cache's owner leaves — they erased their account, or stopped looking after it — the [sysop](../glossary.md#sysop) can put the
cache up for adoption. **Nearby → Up for adoption** lists those caches, nearest first; most are archived, so
they are not on the map.

1. Open the cache. The **Up for adoption** card says why it is offered.
2. Tick **I have checked that the container is in place** if you have been to the site, and add a note for
   the sysop if you like.
3. Tap **Request adoption**. You need to be signed in with a control-verified callsign
   (**Settings → Account → verify**).

The sysop approves one request. The cache becomes yours with all its finds and logbook; if you confirmed the
container is in place it is active again, otherwise it stays archived until you edit it and set it active.
You get an alert either way, and you can withdraw a pending request from the same card.

If a cache of yours is offered, you get an alert and the card shows **Keep my cache**: tap it and the offer
ends. You have 14 days before the cache can change hands.

## Next

- [Cache types](cache-types/index.md).
- [Community](community.md).
