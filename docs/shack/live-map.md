# The live map

This page shows you the map layers for the stations around you as the instance hears them: APRS stations,
activity spots and MeshCom nodes. It is for operators; the switches are under **Search & filter → Live
layers**, and the browser remembers them.

## Live stations and spots

Switch on **Live stations** to see APRS stations on the map as they are heard. Moving stations show a heading
arrow. Tap a station for its page: symbol, speed and course, altitude, recent track, weather and its raw
packets. Signed in, **+ Add to my stations** puts it in your stations; a station already there shows **In
your stations**, and the page says when another operator registered it.

**Activity spots** (off by default) shows live POTA and SOTA activations, and DX-cluster, RBN and PSKReporter
spots, when the instance's sysop enables spots. Filter them by **Band**, **Mode** and **Source**. With a rig
connected ([CAT rig control](rig-weather.md#cat-rig-control)), a spot's card offers **Tune rig to … MHz**.

## MeshCom on the map

When the instance runs a [MeshCom](../run/radios/meshcom.md) node, **MeshCom** (on by default) marks MeshCom
stations with a small **M**. The map shows what the instance's own nodes heard, never the whole network:

- **Heard directly**: the node received the station over LoRa.
- **Heard through a relay**: another node repeated it on the way.
- **Via the MeshCom server**: the node got it from the MeshCom server, not over the air here. The pin has a
  dashed outline.

Stations that reach [APRS-IS](../glossary.md#aprs-is) through a LoRa-APRS [IGate](../glossary.md#igate) show as
ordinary APRS stations.

Open a MeshCom station for how it was last heard, its device and firmware, its battery and signal, and a link
to its page on MeshMap. When its latest message named relays (its _via_ list), the panel shows **Sent via
relays …**: the sender limited forwarding to those nodes. That is its plan, not the path the message took. A
relaying node replaces the list with its own, so the panel takes it only from a message no node relayed.
Visitors see the battery and signal as _high / medium / low_ and _strong / usable / weak_. Signed in, you see
the battery percentage and the signal as RSSI (strength) and SNR (signal-to-noise ratio).

**MeshCom links** (off by default; offered once **MeshCom** is on) draws the links the instance's nodes heard
in the last 24 hours. A solid line is a direct hearing, a dashed line is one leg of a relay path. A line is
wider for a stronger signal and fainter the older it is. Click a line for both ends and the signal. For the
whole network, **Open MeshMap** under the switches leads to [MeshMap](https://meshmap.oevsv.at/), the
network-wide map by ICSSW and ÖVSV.

## Next

- [Packet terminal & BBS](packet-and-bbs.md): decode what you see.
- [Messages over APRS and MeshCom](messages.md): the messages the instance hears.
