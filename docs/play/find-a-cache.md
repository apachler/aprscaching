# Find a cache

This page shows you how to get around the app, pick a cache on the map and get to it. It is for any player;
at the end you stand at the cache with its sheet open, ready to log.

## Get around the app

| What                        | On a phone (bottom bar)                 | On a computer (left rail)               |
| --------------------------- | --------------------------------------- | --------------------------------------- |
| The map                     | **Map**                                 | **Map**                                 |
| The closest caches          | **Nearby**                              | **Nearby**                              |
| Log the open cache          | **Log** (the centre button)             | **✓ Log a find** in the cache sheet     |
| Hide a cache                | **Hide** (the centre button)            | **+ Hide a cache** in the top bar       |
| Recent finds                | **Activity**                            | **Activity**                            |
| Everything else             | **More**                                | its own entry                           |

**More** lists the rest, in the order of the left rail: **You** (your profile), **Messages**, **Ranks**, **Shack**,
**Offline**, **Settings** and **Manual**, plus **Admin** for the sysop. A dot marks one that needs you: a new
message, or a callsign still to verify. The same dot shows on **More** and on the left rail.

The centre button shows **Log** while a cache is open and **Hide** otherwise. On a computer, the **Manual** icon
in the top bar also opens this manual. The bell in the top bar opens your alerts
([Alerts and the watchlist](community.md#alerts-and-the-watchlist)).

![The map on a computer, with the left rail and the Hide a cache button](../assets/shots/map-desktop.webp){ width="720" loading=lazy }

## Search the map

- **Search**: type a cache code (`AC-1234`), a title, a callsign or a grid square (`JN76`) in the search box in
  the top bar. On a phone, tap the magnifier in the top bar to open the search box. Pick a result to open it.
- **Filter**: tap the funnel icon. **Search & filter** opens.
    - **Cache type** shows only the types you pick.
    - **Country and tags** narrows the map to one country, to the caches with any of the tags you pick, or
      both. The choices are the countries and tags of the caches in view. Caches from other instances carry
      neither.
    - **Include unvetted network data** adds caches from instances your sysop has not vetted yet.
    - **Live layers** adds **Live stations** (APRS stations heard now), **MeshCom** nodes and **Activity
      spots** (live POTA and SOTA activations).
- **Basemap**: pick **Map**, **Topo** or **Sat**.
- **Map tools**: a grid-square overlay, range rings, a ruler for distance and bearing, the day and night line,
  and the bearing from your home locator to the open cache.

The corner of the map shows the position under the cursor as latitude and longitude, grid square and MGRS.

![Search and filter on a computer, with cache types and live layers](../assets/shots/filter-desktop.webp){ width="720" loading=lazy }

## List the closest caches

Tap **Nearby**. The list shows the caches and stations closest to you, nearest first, with distance and
direction. The line above it says what it measures from:

- **from you**: the phone has your location, from the locate button on the map or a reading in the last five
  minutes. When you have moved the map away, the list still shows what is within 10 km of you.
- **from map centre**: the app has no location yet. Tap **Use my location** to measure from you, or move the
  map to plan somewhere else.

- **Caches** and **Stations** narrow the list.
- **For adoption** lists caches whose owners are handing them on.

## Open the cache sheet

Tap a marker, a row in **Nearby**, or a search result. The cache sheet shows:

- the title, the type, where the cache comes from (**APRScaching**, or **imported** from a programme such as
  SOTA), the code and the owner;
- **Difficulty** and **Terrain**, from 1 to 5;
- how far away the cache is, once your location is known;
- **Rating**, the description, the **Hint** (tap to show it) and any photos;
- **Verification**: the badge a find needs here to count as verified;
- **Coordinates** with a copy button, the grid square, and **Navigate**;
- **Copy link** and **▦ QR** to share the cache;
- the **Logbook**: everyone's finds, did-not-finds and notes.

![A cache sheet on a computer, with coordinates, verification and the logbook](../assets/shots/detail-desktop.webp){ width="720" loading=lazy }

## Get to the cache

1. Tap **Navigate**. A list of maps apps opens.
2. Tap **Maps app** (your phone's own), **Google**, **Apple** or **OpenStreetMap**. Google and Apple open with a
   route to the cache; the others show the cache on their map.

Without a maps app, tap **Show bearing & distance from here**. The sheet shows an arrow, the bearing and the
distance from where you stand. **Update from here** refreshes it as you walk.

## The "you're near" prompt

When your radio's APRS position is heard within 150 m of a cache, the app shows a banner: **You're near
AC-1234**, with **Log it** and **Dismiss**. **Log it** opens the cache sheet.

The prompt needs three things:

- your radio beacons its position, and this instance hears it, over the air or over the internet;
- the beacon carries the callsign you are signed in with, with any SSID: signed in as `OE8APR`, a beacon from
  `OE8APR-7` prompts you;
- the app is open on your phone or computer.

The phone's own location does not trigger the prompt. Without a radio, use **Nearby** and the distance on the
cache sheet instead.

## Caches from other instances

Your instance can show caches from other instances in its network. Their sheet says **mirrored from** the
other instance and shows the type, difficulty, terrain and owner. You cannot log them here: log your find on
the cache's home instance. It shows here once that instance publishes it.

## Share caches and views

- **Copy link** copies a link to the cache.
- **▦ QR** shows a QR code that opens the cache. **download SVG** saves it for printing.
- **Search & filter** → **Share this view** copies a link to the current map, with its layers and filters.

## Hunt without signal

Before a trip into an area without mobile data, make an offline pack. [Hunt without signal](offline.md) shows
how.

## Next

- [Hunting without signal](offline.md): prepare a hunt where the phone has no data.
- [Log a find](log-a-find.md): log what happened at the cache.
