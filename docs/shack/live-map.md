# The live map

Besides caches, the map shows the stations around you as they are heard: APRS stations, spots and MeshCom
nodes.

## Live stations and spots

Turn on **Search & filter → Live layers → Live stations** to see APRS stations on the map as they are heard;
the browser remembers the switch. Moving stations show a heading arrow. Tap a station for its page: symbol,
speed and course, altitude, recent track, weather, and its raw packets. Signed in, **+ Add to my stations**
puts it in your stations; a station already there shows **In your stations**, and one another operator
registered says so.

**Spots** — when the operator enables them, POTA and SOTA activations (and DX-cluster, RBN and
PSKReporter spots) appear on the map; filter them under **Search & filter → Live layers**.

## MeshCom on the map

When the instance runs a [MeshCom](../run/radios/meshcom.md) node, **Search & filter → Live layers → MeshCom**
(on by default) marks MeshCom stations with a small **M**. What you see is what the instance's own node(s)
heard, never the whole network:

- **Heard directly** — the node received the station over LoRa.
- **Heard through a relay** — another node repeated it on the way.
- **Via the MeshCom server** — the node got it from the MeshCom server, not over the air here; the pin has a
  dashed outline.

Stations that reach [APRS-IS](../glossary.md#aprs-is) through a LoRa-APRS [IGate](../glossary.md#igate) show as ordinary APRS
stations.

Open a MeshCom station for how it was last heard, its device and firmware, its battery and signal, and a
link to its page on MeshMap. When its latest message named relays (its _via_ list), the panel shows "Sent
via relays …": the sender limited forwarding to those nodes. That is its plan, not the path the message
took. Visitors see the battery and signal as _high / medium / low_ and _strong / usable / weak_; signed in,
you see the battery percentage and the signal as RSSI (strength) and SNR (signal-to-noise ratio).

**MeshCom links** (off by default; shown once MeshCom is on) draws the links your node(s) heard in the last
24 hours: a solid line for a direct hearing, a dashed line for each leg of a relay path, wider for a stronger
signal and fainter the older it is. Click a line for both ends and the signal. For the whole network, the
legend and the filter panel link to [MeshMap](https://meshmap.oevsv.at/), the network-wide map by ICSSW and
ÖVSV.

## Next

- [Packet decoder & BBS](packet-and-bbs.md).
