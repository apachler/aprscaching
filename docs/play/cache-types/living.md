# Living caches

This page is for players and hiders. It explains the living cache: a cache that is an APRS station on the
move. You find it by meeting the station.

## What it is

A living cache follows a station that sends its position over [APRS](../../glossary.md#aprs): a car, a hiker
with a handheld, a balloon. The station is the cache. There is no container. Two living caches that meet can
also record a rendezvous.

## How you find it

1. Open the cache. Under the owner, **Rides on** names the station it follows, for example `OE8APR-9`, and how
   old its position is. The pin is at that position.
2. Find out where the station is now. Turn on **Live stations** in **Search & filter** to follow it on the map,
   or arrange a meeting with its operator.
3. Go to the station, with your own APRS radio beaconing your position.
4. While you are with the station, log the find.

## What "found" means

You and the station were in the same place at the same time. The game takes one of your radio positions and
the station's position closest to it in time. The two positions must be at most 5 minutes apart and within
150 m of each other.

## How it is logged and verified

Log it like any cache: **✓ Log a find**, **Couldn't find it** or **Add a note**, in the app or from your radio.

| Tier | You get it when |
|---|---|
| **Radio-verified** | A receiving station the instance runs, and that is not yours, heard your position next to the station's, as above. Your position must be from the 30 minutes before you log. |
| **Location-verified** | Your phone's location, taken when you log, is within 150 m of the station, plus its accuracy. The station's position counts when it was heard at most 5 minutes from that moment. |
| **Logged** | Nothing independent placed you with the station. |

Both tiers check that you met the station; the place where the cache was hidden counts for nothing. A verified
find on a living cache earns the **Rover hunter** badge.

The map pin follows the station: it sits at the station's last heard position, and at the place where the cache
was hidden until the station is first heard.

## What a hider sets

A living cache follows a station of your own: one listed under **Settings → My stations**, which takes only
stations of your verified callsigns. Nobody can make a cache of another operator's beacon. There are three ways to make one:

- **+ Hide a cache**, then pick **Living (APRS)** under **Type**. Under **Station**, pick one of your stations,
  for example `OE8APR-9`; add it under **My stations** first if it is not there. The other fields are those of
  a [traditional cache](traditional.md#what-a-hider-sets).
- **Settings → My stations → ★ Become a cache** makes you the cache. It follows the callsign your beacon was
  last heard with, adds that callsign to **My stations** if it is not there yet, and puts the pin at that
  beacon's position, or at your home locator.
- **Settings → My stations**, open a station, then **⚑ Turn into a cache → Living cache** makes that station
  the cache.

In the hide form, the switch **Log rendezvous when I meet other living caches** opts the cache into
rendezvous. It is off by default. The two paths under **My stations** leave it off. To turn it on later, open
**Settings → My stations**: under each station, every living cache that follows it has its own **Log
rendezvous** switch. The cache's **Edit** form has the same switch.

### Rendezvous

A rendezvous is a meeting between two living caches that both opted in. It is recorded when:

- one of them beacons within 150 m of the other's last position;
- the other was heard in the last 15 minutes;
- the same two caches have not met in the last hour.

The page of each cache lists its last 10 meetings under **Rendezvous**. The cache's owner sees when each
meeting happened, for example "met OE8APR-9 · 2 h ago". Everyone else sees whom the cache met and on which day,
for example "met OE8APR-9 · 2 Oct 2026". The place of a meeting goes to nobody but the owner. A rendezvous is a
social record. It earns no points and is not a find.

## Example

**AC-1234 · Rover on the ridge** · Living (APRS) · station `OE8APR-9`.
The owner hikes with a handheld that beacons every few minutes. OE5XYZ-7 sees OE8APR-9 on the map near JN76,
walks to the hut where the owner rests, and beacons from there. A receiving station of the instance hears
both. OE5XYZ-7 logs the find, and it is **Radio-verified**.

## Tips

- Beacon often while you close in. The game needs one of your positions within 5 minutes of one of the
  station's.
- Your own IGate does not count. A receiving station that is not yours must hear you.
- Talk to the operator. A meeting at a rest stop is easier than a chase.

## Map marker

A blue beacon icon at the cache's pin. In lists and filters the type shows a four-pointed star (✦), or an
asterisk (*) in the Phosphor theme.

## Next

- [How finds are verified](../verification.md).
- [Community](../community.md).
