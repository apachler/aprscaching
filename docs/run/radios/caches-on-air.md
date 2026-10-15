# Caches on air

This page is for the sysop. It sends the caches around your ingest box on air as APRS objects, so any APRS radio
or map nearby shows them with the point-of-interest symbol. At the end your box announces the nearby caches at a
low rate, on a local path only, and takes each one off the air when its cache is archived.

## Before you start

- A sysop session ([Instance settings](../day-to-day/instance-settings.md#before-you-start)).
- An ingest box that transmits on RF: a KISS TNC or a [soundcard port](soundcard.md), with `BOX_ID`,
  `BOX_TX=1` and its own position in `BOX_LAT` and `BOX_LON` ([Remote control of your box](remote-box.md)).
  A box enrolled with its own key also needs **Runs this instance's services** in **Instance admin**.
- The instance's [service call](../../glossary.md#service-call) is the objects' source. It must be
  control-verified and share its base call with the box's station call (`BOX_CALL`): the default service call,
  your first `ADMIN_CALLSIGNS` call with `-15`, does.

## Steps

1. Open **Instance admin** → **Instance settings** → **Caches on air**.
2. Switch on **Send caches as APRS objects**. The rest of the group appears.
3. Enter the box's `BOX_ID` as **Transmitting box** and select **Save**.
4. Check the other values. Their defaults suit most stations:

    | Setting | Default | What it does |
    |---|---|---|
    | **Radius** | 20 km | Only caches this close to the box's own position go on air, 1–50 km. |
    | **Repeat every** | 30 min | How often one object repeats once its first announcements are out, 30–240 min. |
    | **Objects per run** | 2 | The most objects one five-minute run sends, 1–5. |
    | **Path** | none | No digipeater, or `WIDE1-1` for one hop. |

## What goes on air

Every five minutes the gateway picks the caches within the radius of the position the box reports, the nearest
25 at most, and queues the objects that are due for the box. Each object looks like this:

```text
OE8APR-15>APZACG:;AC-1234  *151405z\<compressed position>i  !Old mill
```

- **Name:** the cache code, at most nine characters.
- **Symbol:** `\i`, the point of interest.
- **Position:** the published coordinates in compressed form. For a multi-stage cache that is the public start,
  never a later stage.
- **Comment:** the cache title, cut short.

Only active, public caches hidden on this instance go on air. A living cache beacons for itself and is never an
object; an unlisted cache, an imported place and a cache from another instance never go on air.

The schedule follows WB2OSZ's _APRS Worst Practices_:

- **No frequent repeats.** A new or changed object goes out at once, then 5, 10 and 20 minutes apart, then at
  the **Repeat every** rate. One run sends **Objects per run** at most, so a box with many caches nearby repeats
  each one less often, never more.
- **No wide paths.** The path is none or `WIDE1-1`, and the box refuses any other.
- **No objects far from the transmitter.** The radius is 50 km at most, and the box refuses an object more than
  50 km from its own position.
- **Objects are killed properly.** When a cache is archived, disabled, removed, moved out of the radius or made
  unlisted, its object goes out three times with the killed flag, 5 and 10 minutes apart, so radios and maps
  drop it. Then it stops.

Each object passes the box's transmit gates like any remote transmit: `BOX_TX=1`, the transmit switch, the
command age and the rate limit of three in a burst, then one per minute
([Remote control of your box](remote-box.md#what-the-remote-box-app-can-do)). A run waits while the box has
not collected the previous one, has not polled for two minutes, or reports no position.

Switching **Send caches as APRS objects** off stops the transmissions at once. Objects already on air are not
killed; radios and maps age them out.

## Not through APRS-IS

The gateway never sends cache objects to APRS-IS. They go out only on the box's radio. An IGate near the box may
gate them to APRS-IS, as it does for any station it hears.

A cache object heard back, over the air or through APRS-IS, is never stored as the service call's position. No
object or item counts as evidence for a find ([Verification](../../play/verification.md)).

## Check that it worked

- **Shack** → **Remote box** shows each object in the command log: `object AC-1234 sent as OE8APR-15`, or the
  reason the box refused it.
- A radio with an APRS display near the box lists the caches as objects, with the point-of-interest symbol.

## Next

- [Automatic stations on the air](../compliance/on-air-stations.md): the rules for a box that transmits.
- [Instance settings](../day-to-day/instance-settings.md): the other values you change in the app.
