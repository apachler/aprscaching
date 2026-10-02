# Hunt without signal

This page shows you how to hunt and log where your phone has no data: in the mountains, abroad without
roaming, or at a field day. You prepare once with a connection; out there you find and log, and the app syncs
when the signal returns.

## Before you go

1. **Open the app once with a connection**, on the phone you take, and sign in. From then on it opens without
   one too. Add it to the home screen: the phone then keeps the app and its data more reliably.
2. **Log once with signal** on a new phone, so its device key is registered with the instance. A find made
   offline is signed with that key.
3. **Make an offline pack** of where you are going: open **Offline** (or **Offline packs** in **Nearby**).

### Offline packs

A pack is one **Maidenhead locator square**. Type the locator, or take the square at the map centre. The
square is outlined on the map. Under **Only some cache types** you can leave types out.

| Size             | Example    | Covers               |
| ---------------- | ---------- | -------------------- |
| Field            | `JN`       | 20° × 10°            |
| Square           | `JN77`     | 2° × 1°              |
| Subsquare        | `JN77sb`   | about 6 × 4.6 km     |
| Extended square  | `JN77sb42` | about 600 × 460 m    |

**Check size** fetches the pack's data first and shows what it holds before anything is kept:

- the caches (at most 5000 in a pack), each with its description, hint, latest 5 logs and the shape of its
  stages;
- the images: none, a **thumbnail** per cache (a few kilobytes each), or every image;
- the **map** of the square, if your instance offers one: as detailed as fits the pack's 250 MB, without
  place names. Without one, the offline map is a grid under the caches. Ask your sysop
  ([The offline map](../run/install/offline-map.md)).

**Download** keeps it. **Refresh** brings a pack up to date and costs almost nothing when nothing changed; a
pack older than a week says so. The area you last browsed is kept automatically too.

The browser is asked to keep your packs. If it may still clear them when space runs low, the Offline panel says
so; adding the app to the home screen helps.

**Owners:** **Your caches → Pack my caches** packs every cache you own, wherever it is. It lists the ones that
need a visit: several did-not-finds in a row, no find for months, or disabled. **Post as maintenance** in a cache's
log form works offline like any log.

## Out there

- **The map** shows the caches of every pack in view and says where they came from: **Offline — caches from pack
  “JN77sb”, 2 days old**.
- **A cache page** shows its stored copy. Find counts, favourites and ratings show once you are back online.
- **Log a find** as always. It is saved: **Saved — offline, will sync when you're back online**.
- **Multi-stage caches:** a pack shows the published start. An **NFC stage** with a long enough tag code
  travels sealed under that code. Long enough means the tag's serial, or nine or more random letters and
  digits. Scan the tag, or type its code, and the next stage opens on the phone. A **geo stage**, or an NFC
  stage with a short code, unlocks only online. Checking where you stand needs the instance, and anyone
  holding the pack could guess a short code. A stage's position or clue is never in a pack in the clear.
- **No data, but a radio?** In **Logs to sync**, each waiting find, DNF or note offers **Send it from a radio**.
  It shows the APRS message (`FOUND AC-1234 …`) and the service call, ready to copy into your handheld. Sent
  that way, it follows the [radio rules](log-a-find.md#log-from-your-radio). Then tap **I sent it by radio**,
  so the app does not log it a second time.

## Back online

The app syncs on its own when it starts and when the connection returns. It sends your logs first. Then it
refreshes packs older than a day, on Wi-Fi only unless **Offline → Sync → Refresh packs on mobile data** is
on. **Sync now** in **Logs to sync** does it at once and refreshes every pack on any connection.

With the app closed, Chrome and Edge send waiting logs in the background. **Safari, Firefox and iPhones have
no Background Sync**, so there the logs go when you next open the app.

The top bar says what waits: **2 logs waiting · 1 needs attention · pack “JN77sb” 3 days old**.

**Your find is verified at the time you made it**, not when it synced. It is signed with that time. The
instance checks your APRS track and your phone's location against that moment, so the find gets the badge it
would have had with signal. That holds for up to 7 days. The logbook shows **logged offline at 10:02, synced
18:14**.

A find without a device signature, from a browser that cannot sign, counts from when it arrives. A wrong
phone clock matters too. A time more than a minute ahead, or before you registered the device, is not taken,
and the find counts from its arrival.

**Nothing is lost.** If the instance refuses a log when it syncs, for example because the cache was deleted,
the log moves to **Needs attention** with the reason. There you retry it, edit its comment, or discard it. A
log goes only to the instance it was made on; signed in to another, it waits and says so.

A cache archived or disabled while your find waited refuses it when it syncs: the find lands under **Needs
attention**, with the reason.

## Where this helps

- **A club hunt or field day on a Pocket station.** A Pocket station is an instance on one Android phone.
  The other phones join its hotspot and use it as their instance, with no internet at all. The caches, the
  logs and the map all come from the phone in the field. Back home, the Pocket station sends everything on to
  its home instance. Ask your sysop ([Install Pocket](../run/install/pocket.md)).
- **SOTA and POTA activations.** Pack the summit's or park's subsquare. Log the cache next to the activation
  with no coverage. You can also send the find by radio over the activation's own APRS path.
- **Holidays abroad without roaming.** Pack the squares you will visit on hotel Wi-Fi; finds sync the next time
  you are on Wi-Fi.
- **EmComm exercises.** Packs and a Pocket station keep a team working while the networks are down on
  purpose. The radio path carries finds and notes over APRS.

## Next

- [Log a find](log-a-find.md).
- [How finds are verified](verification.md).
