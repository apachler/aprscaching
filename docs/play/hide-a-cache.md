# Hide a cache

This page is for hiders. It covers what to check before you hide, how to place a cache in the app, who sees
it, and how to look after it or hand it on.

## Before you hide

A cache sends strangers to a place. Make sure they are welcome there and safe.

- **Ask the landowner.** Get permission before you place a container on private land. On public land, ask
  the authority that manages it: the town, the forest office or the park.
- **Respect nature.** Stay out of nature reserves and protected areas unless the rules there allow it. Keep
  away from nests, dens and rare plants. Finders follow your pin, so pick a spot reached by a path.
- **Keep it safe.** No spots next to roads, railways, cliffs, water or busy junctions. A finder must not need
  to climb, trespass or take a risk you would not take.
- **Do not bury it, and do not damage anything.** Do not dig, cut, drill or nail. Leave walls, trees and
  monuments as they are.
- **Do not alarm anyone.** Stay away from schools, playgrounds, police and military sites, power stations and
  bridges. Use a clear container and label it with the cache code and a note on what it is.
- **Use a good container.** It should be waterproof and sturdy, with a logbook and a pencil.
- **Hide near home.** You maintain the cache. Pick a place you can visit again.
- **Follow local rules.** Some places ban or restrict containers. When in doubt, ask first.

## Hide your first cache

You need to be signed in. Stand at the spot, or know its coordinates.

1. Tap **+ Hide a cache** in the top bar. On a phone, tap **Hide** in the tab bar. The **Hide a cache**
   panel opens.
2. Place the pin under **Location**:
    - On a phone the pin starts at your position.
    - Or tap **Use my location**, or tap the map.
    - Or type decimal degrees or a Maidenhead locator in **Coordinates** and tap **Place pin**.

    The panel shows **Pin at** with the coordinates and the grid square. Drag the pin to adjust it.

3. Under **Basics**, type a **Title** and pick a **Type**. The line under the type says what it means.
4. Under **Difficulty & terrain**, set **Difficulty** and **Terrain** with the sliders.
5. Optional: open **Advanced: hint, description, rating & sharing** and fill in what you want
   ([Options](#options)).
6. Tap **Hide cache**. The map moves to your cache and opens its page.

## Check that it worked

The cache page shows your title and a new code, for example `AC-1234`. The cache is on the map. Your first
hide earns the **Hider** badge on your profile.

## Options

| Option | What it does | Default |
|---|---|---|
| **Title** | The name finders see. Up to 120 characters. | none, required |
| **Type** | What kind of cache it is ([Cache types](cache-types/index.md)). | Traditional |
| **Difficulty** | How hard the cache is to find, 1 to 5 in steps of 0.5. | 1.5 |
| **Terrain** | How hard the place is to reach, 1 to 5 in steps of 0.5. | 1.5 |
| **Hint** | A spoiler that finders open with a tap. Up to 500 characters. It never leaves this instance. | empty |
| **Description** | The story of the cache. Up to 4,000 characters. | empty |
| **Drive-in (car-accessible)** | Marks a cache you can reach by car. | off |
| **Country** | A country code or short name, such as `AT`. | empty |
| **Tags** | Words separated by commas, such as `scenic, family, qrp`. Up to 12 tags of 24 characters. | none |
| **Who can rate** | **Finders only**, **Anyone signed in** or **Nobody (disabled)**. | Finders only |
| **Federation scope** | Who sees the cache ([Who sees your cache](#who-sees-your-cache)). | Public |

Difficulty and terrain also add to a finder's points ([Ranks](community.md#ranks)).

The hide form offers Traditional, Multi-stage, Living (APRS), Audio, Virtual, SOTA summit and POTA park.

!!! note "Known issue"
    Any player can hide a SOTA summit or POTA park. A find on one earns the summit or park badge, as a find on
    the real summit or park does.

Every cache needs a find that is **Location-verified** or better to count as verified
([How finds are verified](verification.md)). The hide form has no setting for this.

!!! note "Known issue"
    The minimum is fixed at **Location-verified** on every instance. A cache's minimum can be raised to
    **Radio-verified**, but not in the app, and once raised it cannot go back.

## Who sees your cache

Instances can link up and share caches with each other. **Federation scope** decides what the other
instances get:

| Scope | On this instance | Other instances |
|---|---|---|
| **Public** | map, search, RSS | the whole cache |
| **Unlisted** | map, search, RSS | the title and position, without the description |
| **Local only** | map, search, RSS | nothing |

The hint never leaves this instance, whatever the scope.

!!! note "Known issue"
    **Unlisted** does not hide a cache. It still shows on this instance's map, in search and in RSS. Other
    instances get its title and position and can show it on their maps.

## Stages, living caches and media

**Stages.** A multi-stage cache leads finders through stages to the final spot
([Multi-stage caches](cache-types/multi.md)). The app cannot add stages yet. Ask your sysop to add them.

**Living caches.** A living cache moves with a beaconing APRS station ([Living caches](cache-types/living.md)).
Pick **Living (APRS)** as the type and, under **Station**, one of your own stations from **Settings → My
stations**, for example `OE8APR-9`. Switch on **Log
rendezvous when I meet other living caches** if you want meetings with other living caches recorded. You can
also turn your own station into a cache: **Settings → My stations**, then **Become a cache** or **Turn into a
cache**.

**Media.** Open your cache and add files under **Media**. You must be signed in as the callsign that owns the
cache.

- Photos, audio, PDF, text and zip files.
- Up to 20 items per cache, 10 MB each.
- The app scales a photo to at most 1,600 pixels on its longest side before upload.
- Everyone can see and play the media.

## Maintain your cache

- **Needs maintenance.** When the last three find or **Couldn't find it** logs are all **Couldn't find it**, the
  cache page shows **needs maintenance**. The next find clears it. Notes do not count.
- **Owner alerts.** You get an alert each time someone logs a find on your cache. It shows under **Settings →
  Notifications**, and by push or email if you switched those on.
- **Maintenance log.** After a visit, open the cache, tap **Add a note**, write what you checked or fixed and
  tap **Post as maintenance**.
- **Your caches offline.** **Offline → Your caches → Pack my caches** stores all your caches for a field trip.
  It flags the ones that need a visit: three or more did-not-finds in a row, no find for months, or disabled.

The app cannot edit, disable or archive a cache yet. Ask your sysop.

## Cache adoption

When an owner stops looking after a cache, or leaves, the sysop can offer it for adoption. The sysop sets
this up ([Cache adoption](../run/day-to-day/cache-adoption.md)).

**Adopt a cache.** You need a [verified callsign](../glossary.md#verified-callsign).

1. Open **Nearby** and pick **For adoption** under **Show**. The list shows caches up for adoption, nearest
   first. Most are archived, so they are not on the map.
2. Tap a cache. The **Up for adoption** card shows the sysop's note.
3. Tick **I have checked that the container is in place** if you visited the site. Add a **Note for the
   sysop** if you like.
4. Tap **Request adoption**. The card says your request is waiting for the sysop.

The sysop approves one request, and you get an alert. The cache becomes yours with all its finds, logs and
media. If you ticked the box, the cache is active again. If not, it stays archived; ask your sysop to set it
active. You can tap **Withdraw my request** while you wait.

**If your cache is offered.** You get an alert, and the cache page shows **Keep my cache**. Tap it and the
offer ends. The cache cannot change hands for 14 days after the offer, so you have time to answer. A cache
whose owner erased their account has no waiting time.

## Next

- [Cache types](cache-types/index.md): what each type means for finders.
- [Community](community.md): ratings, favourites, badges and ranks.
