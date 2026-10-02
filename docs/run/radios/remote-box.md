# Remote control of your box

This page pairs your ingest box with your account, so you can drive it from the web app. It is for the
sysop who runs the box; at the end **Shack → Remote box** sends it commands and shows each result.

The box opens no inbound port. The app queues commands at the gateway, and the box collects them over its
own outbound connection (`/api/box/<id>/…`), runs them, and reports each result to the command log.

## Before you start

- A running ingest box ([Set up an ingest box](ingest-box.md)) and access to its log.
- An account on the instance. Transmit commands also need a verified callsign on that account
  ([Callsign verification](../day-to-day/callsign-verification.md)).
- An enrolled box whose code you created while signed in is yours already: skip the pairing steps.

## Pair the box

1. On the box, set `BOX_ID` to a name of your choice, for example `pi-home`, and restart the ingest. At start
   the box prints a one-time pairing code to its log:
   `[box] pairing code for pi-home: ABCD-EFGH (valid 15 min) — enter it under Shack → Remote box …`.
2. In the app, open **Shack → Remote box**. Enter the same name as the **Box ID**, then the
   **Pairing code**, and select **Pair box**. The box now belongs to your account: no other account can send
   it commands or read its log.
3. Select **Status**. Within a few seconds the command log shows the box's uptime and which functions are
   on.

The code works once and expires after 15 minutes; restart the box for a fresh one. Pairing again with a new
code moves the box to whoever enters it, so only someone who can see the box's output can take it over.

## What the Remote box app can do

| Command | Needs on the gateway | Needs on the box |
|---|---|---|
| **Status** | the paired account | `BOX_ID` |
| **IGate off**, **TX off** | a verified callsign on the paired account | `BOX_ID` |
| **Beacon here** (the map centre, with an optional comment), **Message**, **IGate on**, **Digi on** | a verified callsign on the paired account | `BOX_TX=1`, and the conditions below |

A command that switches a function **on** runs on the box only when `BOX_TX=1` is set there and the
command's callsign has the same base call as the box's station call (`BOX_CALL`, else `IGATE_CALL`, else
`DIGI_CALL`). A beacon or a message also has to:

- be queued within the last `BOX_CMD_MAX_AGE` seconds (default 900, 15 minutes), so a box that was offline
  never sends a stale beacon or message;
- find transmit switched on, and a KISS TNC on the box;
- fit the box's rate limit: three in a burst, then one per minute.

The app asks you to confirm each of these commands before it queues it. A refused command shows in the
command log with the reason.

**TX off** is the box's master switch: it silences the APRS digipeater, IGate transmit to RF and remote
transmits until switched on again or the ingest restarts. The switches live in memory, so a restart returns
the box to its configured state.

## Answers to radio commands

With `BOX_TX=1` the box also answers players' radio commands that it heard itself, such as `FOUND AC-1234`
sent to `APRSCG` ([Log from your radio](../../play/log-a-find.md#log-from-your-radio)). The ack goes out on its
own radio as third-party traffic from `APRSCG` under `BOX_CALL`, or through its MeshCom node when
`MESHCOM_TX=1` ([MeshCom](meshcom.md#answering-radio-commands-optional)). A box with a radio therefore
acknowledges finds even without internet. These answers pass the same gates: the transmit switch, the command
age and the rate limit.

Every `BOX_*` setting is in [Configuration](../../reference/configuration.md); the rate limits are in
[Transmit pacing](../compliance/on-air-stations.md#transmit-pacing).

## Next

- [Off-grid and LAN](../networks/off-grid.md): run the instance with no internet.
- [Automatic stations on the air](../compliance/on-air-stations.md): the rules for a box that transmits.
