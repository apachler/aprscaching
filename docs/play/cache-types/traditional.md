# Traditional caches

This page is for players and hiders. It explains the traditional cache: one container at the spot the pin
marks. Every other cache type builds on it.

## What it is

A traditional cache is one container at a fixed spot. The pin on the map is the spot. The cache sheet shows
its coordinates, its grid square, a difficulty and terrain rating, and an optional hint.

## How you find it

1. Open the cache from the map, from **Nearby**, or from a search.
2. Tap **Navigate** to take the coordinates to your maps app.
3. At the spot, search for the container. Tap **Hint** if you are stuck.
4. Sign the paper log in the container if there is one, then log the find in the app.

## What "found" means

You were at the pin when you logged. The game checks this against the pin's position: within 150 m, plus the
accuracy of your phone's location. Nothing checks that you opened the container.

## How it is logged and verified

Tap **✓ Log a find**. You can also log **Couldn't find it** (a [DNF](../../glossary.md#dnf)) or **Add a
note**. Each callsign logs one find per cache. You can also log from your radio with `FOUND AC-1234`.

A find reaches one of three tiers:

| Tier | You get it when |
|---|---|
| **Radio-verified** | A receiving station the instance runs, and that is not yours, heard your APRS position within 150 m of the pin. Your position must be from the 30 minutes before you log. |
| **Location-verified** | Your phone's location, taken when you log, is within 150 m of the pin plus its accuracy. |
| **Logged** | Nothing independent placed you there. The find is on record but not verified. |

A find counts as verified at **Location-verified** or better. A hider can ask for **Radio-verified** instead.
The cache sheet shows the rule under **Verification**. [How finds are verified](../verification.md) explains
the tiers.

A disabled or archived cache takes no finds, and an owner does not log their own cache as found
([Caches that take no find](../log-a-find.md#caches-that-take-no-find)).

## What a hider sets

Tap **+ Hide a cache** (on a phone, **Hide**) and pick **Traditional** under **Type**.

| Field | Default | Notes |
|---|---|---|
| The pin | your location on a phone | Tap the map, tap **Use my location**, or type coordinates or a locator. |
| **Title** | none | Up to 120 characters. |
| **Difficulty**, **Terrain** | 1.5 | From 1 to 5, in steps of 0.5. They add to a finder's points. |
| **Hint** | none | Up to 500 characters. Other instances never get it. |
| **Description** | none | Up to 4000 characters. |
| **Drive-in**, **Country**, **Tags** | off, none, none | Up to 12 tags. |
| **Who can rate** | **Finders only** | Or **Anyone signed in**, or **Nobody (disabled)**. |
| **Federation scope** | **Public** | Or **Unlisted**, or **Local only**. |

The fields from **Hint** down are under **Advanced**. After you hide the cache, add photos in its **Media**
section. To ask for **Radio-verified** finds only, or to edit, disable or archive the cache: this is not in
the app yet; ask your sysop.

## Example

**AC-1234 · Bench above the lake** · Traditional · Difficulty 1.5 · Terrain 2.0 · grid JN76xx.
The hint reads "Behind the third post". OE8APR-7 logs at the bench with location allowed. The phone is 12 m
from the pin, so the find is **Location-verified**.

## Tips

- Allow location access when you log. Without it, the find stays **Logged** unless a receiving station heard
  you.
- Beacon your position near the cache before you log. Where the instance runs its own receivers, that can
  make the find **Radio-verified**.
- Make an offline pack before you go somewhere without coverage. See [Hunting without signal](../offline.md).

## Map marker

A pin in green with a filled circle (●). The Phosphor theme shows the same circle.

## Next

- [Log a find](../log-a-find.md).
- [Multi-stage caches](multi.md).
