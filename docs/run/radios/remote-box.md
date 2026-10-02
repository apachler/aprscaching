# Remote control of your box

You can drive your own ingest box from the web app without opening any inbound port: the app enqueues
commands and the box pulls them over its existing outbound connection (`/api/box/:id/*`), runs them, and
reports each result back to the command log in **Shack → Remote box**.

1. On the box, set `BOX_ID` to a name of your choice (for example `pi-home`) and restart the ingest. At start
   the box prints a one-time pairing code to its log:
   `[box] pairing code for pi-home: ABCD-EFGH (valid 15 min)`.
2. In the app, enter the same name as the **Box ID**, then the **Pairing code**, and press **Pair box**. The
   box then belongs to your account; no other account can send it commands or read its log. The code is
   single-use and expires after 15 minutes — restart the box for a fresh one. Pairing again with a new code
   moves the box to whoever enters it, so only someone who can see the box's output can take it over.
3. Press **Status**: within a few seconds the log shows the box's uptime and which functions are on.

Status and switching the digipeater, IGate or transmit **off** work with `BOX_ID` alone. Anything that keys
the radio — a beacon, a message, or switching a function **on** — is gated twice:

- the gateway accepts it only for a **verified callsign** your account holds;
- the box runs it only when you set `BOX_TX=1` on the box, the command's callsign has the same base call
  as the box's station call (`BOX_CALL`, else `IGATE_CALL`, else `DIGI_CALL`), and it was queued within the
  last `BOX_CMD_MAX_AGE` seconds (15 minutes by default). Remote transmits are also rate-limited on the box
  (three in a burst, then one per minute).

**TX off** is the box's master switch: it silences the APRS digipeater, IGate transmit to RF and remote
transmits until switched on again or the ingest restarts. The switches live in memory, so a restart
returns the box to its configured state. See [Configuration](../../reference/configuration.md) for every
variable.

With `BOX_TX=1` the box also answers players' radio commands (`FOUND AC-1234` sent to `APRSCG`,
[Log from your radio](../../play/log-a-find.md#log-from-your-radio)) that it heard itself: the ack goes out on
its own radio as third-party traffic from `APRSCG` under `BOX_CALL`, or through its MeshCom node when
`MESHCOM_TX=1`, so a box with a radio acknowledges finds even without internet. These answers pass the same
gates — the transmit switch, the command age and the rate limit.

## The Remote box app

**Remote box** (operator) sends commands to the instance's ingest box from the web app. The box collects
them over its own outbound connection, so it needs no open port. Link the box once by entering the pairing
code it prints when it starts; each command's result appears in the command log. Transmit commands need a
verified callsign, and the box must allow remote transmit. Setting up the box is covered in
[Remote control of your box](remote-box.md).

Live stations and activity spots are map layers: see [Caching → Live stations and spots](../../shack/live-map.md#live-stations-and-spots).

## Next

- [Off-grid and LAN](../networks/off-grid.md).
