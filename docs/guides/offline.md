# Hunting without signal

aprscaching works where the phone has no data: in the mountains, abroad without roaming, at a field day on a
Pocket station's hotspot. Prepare once with a connection; out there, open the app, find, log, and let it sync
when the signal returns.

## Before you go

1. **Open the app once with a connection**, on the phone you take, and sign in. From then on it opens without
   one too. Add it to the home screen: the phone then keeps the app and its data more reliably.
2. **Log once with signal** on a new phone, so its device key is registered with the instance. A find made
   offline is signed with that key.
3. **Make an offline pack** of where you are going: open **Offline** (or **Offline packs** in **Nearby**).

### Offline packs

A pack is one **Maidenhead locator square**. Type the locator, or take the field (`JN`, 20° × 10°), square
(`JN77`, 2° × 1°), subsquare (`JN77sb`, about 6 × 4.6 km) or extended square (`JN77sb42`, about 600 × 460 m)
at the map centre; the square is outlined on the map. Under **Only some cache types** you can leave types out.

**Check size** fetches the pack's data first and shows what it holds before anything is kept:

- the caches (at most 5000 in a pack), each with its description, hint, latest 5 logs and the shape of its
  stages;
- the images: none, a **thumbnail** per cache (a few kilobytes each), or every image;
- the **map** of the square, when the instance offers an [offline map](../operate/offline-map.md): as detailed as
  fits the pack's 250 MB, without place names. Without one, the offline map is a grid under the caches.

**Download** keeps it. **Refresh** brings a pack up to date and costs almost nothing when nothing changed; a
pack older than a week says so. The area you last browsed is kept automatically too.

The browser is asked to keep your packs. If it may still clear them when space runs low, the Offline panel says
so; adding the app to the home screen helps.

**Owners:** **Your caches → Pack my caches** packs every cache you own, wherever it is, and lists the ones that
need a visit (several did-not-finds in a row, no find for months, disabled). **Post as maintenance** in a cache's
log form works offline like any log.

## Out there

- **The map** shows the caches of every pack in view and says where they came from: **Offline — caches from pack
  “JN77sb”, 2 days old**.
- **A cache page** shows its stored copy. Find counts, favourites and ratings show once you are back online.
- **Log a find** as always. It is saved: **Saved — offline, will sync when you're back online**.
- **Multi-stage caches:** a pack shows the published start. An **NFC stage** whose tag code is long enough (the
  tag's serial, or nine or more random letters and digits) travels sealed under that code: scan the tag, or
  type its code, and the next stage opens on the phone. A **geo stage**, or an NFC stage with a short code,
  unlocks only online: checking where you stand is the instance's job, and a short code could be guessed by
  anyone holding the pack. A stage's position or clue is never in a pack in the clear.
- **No data, but a radio?** In **Logs to sync**, each waiting find, DNF or note offers **Send it from a radio**:
  the APRS message (`FOUND AC-1234 …`) to the instance's service call, ready to copy into your handheld. Sent
  that way, it counts by the [radio path's](caching.md#log-from-your-radio) rules; tap **I sent it by radio** so
  the app does not log it a second time.

## Back online

The app syncs on its own when it starts and when the connection returns: first your logs, then packs older
than a day, on Wi-Fi only unless **Offline → Sync → Refresh packs on mobile data** is on. **Sync now** in
**Logs to sync** does it at once and refreshes every pack on any connection. With the app closed, Chrome and
Edge send waiting logs in the background; **Safari, Firefox and iPhones have no Background Sync**, so there they
go when you next open the app.

The top bar says what waits: **2 logs waiting · 1 needs attention · pack “JN77sb” 3 days old**.

**Your find is verified at the time you made it**, not when it synced. It is signed with that time, and the
instance matches your APRS track and your phone's location against that moment, so it gets the tier it would
have had with signal. That holds for up to 7 days (older position evidence is gone by then); the logbook shows
**logged offline at 10:02, synced 18:14**. A find without a device signature (a browser that cannot sign)
counts from when it arrives. A wrong phone clock matters: a time more than a minute ahead, or before you
registered the device, is not taken, and the find counts from its arrival.

**Nothing is lost.** If the instance refuses a log when it syncs — the cache was deleted meanwhile, say — it
moves to **Needs attention** with the reason, where you retry it, edit its comment, or discard it. A log goes
only to the instance it was made on; signed in to another, it waits and says so.

## Where this helps

- **A club hunt or field day on a Pocket station.** The phones join the [Pocket station's](../operate/pocket.md)
  hotspot and use it as their instance, with no internet at all: the caches, the logs, the map (if the station
  serves an offline map) all come from the phone in the field. Back home, the Pocket pushes everything to its home
  instance on its own, resuming where it stopped ([federation catch-up](federation.md)).
- **SOTA and POTA activations.** Pack the summit's or park's subsquare; log the cache next to the activation
  with no coverage, and send the find by radio through the activation's own APRS path if you like.
- **Holidays abroad without roaming.** Pack the squares you will visit on hotel Wi-Fi; finds sync the next time
  you are on Wi-Fi.
- **EmComm exercises.** Packs and a Pocket station keep a team working while the networks are down by design; the
  radio fallback carries finds and notes over APRS.
