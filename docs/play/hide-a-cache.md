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
| **Country** | The DXCC entity it lies in, shown with its prefix, such as `OE` for Austria. | the country of your callsign |
| **Tags** | Words separated by commas, such as `scenic, family, qrp`. Up to 12 tags of 24 characters. | none |
| **Who can rate** | **Finders only**, **Anyone signed in** or **Nobody (disabled)**. | Finders only |
| **Federation scope** | Who sees the cache ([Who sees your cache](#who-sees-your-cache)). | Public |

Difficulty and terrain also add to a finder's points ([Ranks](community.md#ranks)).

The hide form offers Traditional, Multi-stage, Living (APRS), Audio and Virtual. SOTA summits, POTA parks and
the other [heritage places](cache-types/heritage.md) come from the sysop's import, so their badges stand for
the real place. To hide a cache on a summit, hide it as a traditional cache.

A find counts as verified from the instance's minimum up, **Location-verified** unless your sysop asks for
**Radio-verified** ([How finds are verified](verification.md)). Under **Advanced**, the switch **Radio-verified
finds only** sets your cache's own minimum to **Radio-verified**, whatever the instance's is. Turn it off under
**Edit** and the instance's minimum applies again.

## Who sees your cache

Instances can link up and share caches with each other. **Federation scope** decides what the other
instances get:

| Scope | On this instance | Other instances |
|---|---|---|
| **Public** | map, search, RSS | the whole cache |
| **Unlisted** | its link and code only | the title and position, without the description, kept off their maps |
| **Local only** | map, search, RSS | nothing |

An **Unlisted** cache stays off the map, search, RSS, GPX downloads, offline packs and watch alerts. You see it
on your own map and in your own search. Anyone with its link or code opens its page and can log it. Unlisted
keeps a cache out of sight; it does not make it secret.

The hint never leaves this instance, whatever the scope.

## Stages, living caches and media

**Stages.** A multi-stage cache leads finders through stages to the final spot
([Multi-stage caches](cache-types/multi.md)). Hide the cache first, then open it, tap **Edit** and add the stages
under **Stages**.

**Living caches.** A living cache moves with a beaconing APRS station ([Living caches](cache-types/living.md)).
Pick **Living (APRS)** as the type and, under **Station**, one of your own stations from **Settings → My
stations**, for example `OE8APR-9`. Switch on **Log
rendezvous when I meet other living caches** if you want meetings with other living caches recorded. You can
also turn your own station into a cache: **Settings → My stations**, then **Become a cache** or **Turn into a
cache**.

**Media.** Open your cache and add photos and sound under **Media**. You must be signed in as the callsign that
owns the cache.

- Photos: JPEG, PNG, WebP, GIF or AVIF. Sound: MP3, Ogg, WAV or M4A.
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

## Edit your cache

Open your cache and tap **Edit**, next to the favourite heart. Only the owner sees it.

1. Change what you need. The form is grouped as the hide form is:
    - **Basics**: the title, the status, difficulty and terrain;
    - **Location**: type new coordinates or a locator under **Move to**; a living cache has none, it follows its
      station;
    - **Details**: hint, description, drive-in, country and tags;
    - **Verification, rating & sharing**: **Radio-verified finds only**, who can rate, the federation scope, and
      for a living cache the rendezvous switch.
2. Tap **Save changes**. The cache page shows the new version.

**Status.** **Disabled** keeps the cache on the map and refuses finds, for a cache that needs repair.
**Archived** takes it off the map, for a cache that is gone; the app asks first. Either one can be set back to
**Active** here.

**Stages.** A multi-stage or audio cache has **Stages** at the end of the form: the open start and the locked
stages in order, each with its unlock, position and clue. **Add a stage** and **Remove the last stage** change
the list; **Save stages** stores it. A finder who unlocked a stage you changed, or one after it, unlocks those
stages again, so the app asks before it saves. An audio stage's clip uploads once the stage is saved.

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
