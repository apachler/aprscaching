# MeshCom

This page connects a MeshCom node on your LAN to your ingest box. It is for the sysop. At the end MeshCom
positions are on the map and direct messages in the message log. A direct hearing by your own node can
count toward Tier A.

[MeshCom](https://icssw.org/meshcom/) is a LoRa text-and-position mesh for licensed radio amateurs on
70 cm (433.175 MHz in Germany, Austria and Switzerland). A MeshCom node can stream everything it handles to
your ingest box as JSON over UDP: the node's **ExtUDP** interface. The protocol itself is in
[MeshCom ExtUDP protocol](../../reference/meshcom-extudp.md).

## Before you start

- A MeshCom node that joins your Wi-Fi as a client. ExtUDP does nothing while the node runs its own access
  point.
- **Firmware 4.35t built on or after 2026-09-25, or newer.** Older firmware can crash an ESP32 node with
  ExtUDP switched on. The box warns once in its log when a node reports older firmware; for 4.35t it cannot
  tell the build date and says so.
- The ingest box ([Set up an ingest box](ingest-box.md)) on the same LAN as the node: a Pi, PC or mini-PC.
  ExtUDP has no authentication, so the node and the box talk over your LAN only, never across the internet.
- In Docker, the ingest container must receive UDP 1799: [From a container](rf-ingest.md#from-a-container).
  On Pocket, `meshcom-setup.sh` does the setup on the phone ([A MeshCom node](../pocket/field-station.md#a-meshcom-node)).

## 1. Point the node at the box

On the node's serial console, the MeshCom app, or its web page:

```
--setssid <your Wi-Fi name>
--setpwd <your Wi-Fi password>
--extudpip <the ingest box's LAN address>
--extudp on
```

The node sends to port **1799** on the box; the firmware fixes the port.

## 2. Tell the box about the node

In the ingest box's settings (`deploy/.env` in Docker):

```
MESHCOM_NODE=192.168.1.50=OE8APR-12
```

- The address is the node's LAN address. The box drops datagrams from any other address.
- `=OE8APR-12` is the node's own callsign. It is optional but recommended: it lets the box recognise the
  node's own frames, and it names the node as the receiving site of what it hears directly (see
  [trust](#how-meshcom-traffic-is-trusted)).
- Several nodes: separate them with commas, `192.168.1.50=OE8APR-12,192.168.1.51=OE8APR-13`.

Restart the ingest. Its log shows:

```
[meshcom] listening udp/1799 on 192.168.1.10 for 192.168.1.50 (OE8APR-12)
```

### Optional settings

| Variable | Default | What it does |
|---|---|---|
| `MESHCOM_BIND` | this host's address on the node's subnet | The local address to listen on. Leave it blank; set it only when the box has several addresses on that subnet. `0.0.0.0` listens on every interface and is logged as a warning: never use it on a host reachable from the internet. |
| `MESHCOM_FANOUT` | — | Other programs on the box that also want the node's datagrams (MeshcomWebDesk, gomeshcomd, Home Assistant…), as `host:port` pairs. Only one program can own port 1799; the box owns it and passes each accepted datagram on. |
| `MESHCOM_RATE` | `20` | Maximum datagrams per second accepted from one node. |
| `MESHCOM_STALE_MIN` | `30` | Minutes of silence after which the box warns that a node has gone quiet. |
| `MESHCOM_PORT` | `1799` | The local port. The node always sends to 1799; change this only behind your own relay. |

### Answering radio commands (optional)

Players can log a find by sending a MeshCom direct message such as `FOUND AC-1234` to the instance's
[service call](../../glossary.md#service-call) ([Log from your radio](../../play/log-a-find.md#log-from-your-radio)):
your callsign with SSID 15, such as `OE8APR-15`. MeshCom nodes drop a direct message to an address without a
digit, so the service call is always a callsign; give your node and your other stations another SSID, or the
node takes the players' messages as its own. To let the box acknowledge those messages, and send the
instance's text replies, through the node that heard them, set on the box:

```
BOX_ID=pi-home
BOX_TX=1
MESHCOM_TX=1
MESHCOM_TX_CALL=OE8APR
```

The node then transmits automatically under your callsign: read
[Automatic stations on the air](../compliance/on-air-stations.md) first.

The node transmits every message under its own call, so `MESHCOM_TX_CALL` must be your call, the base call
of the node's (`OE8APR-12` above). The box then logs `[meshcom] transmit enabled as OE8APR` and records each
send in its log (time, node, destination, size and outcome, never the text). Sends share a rate limit of
one per minute, three in a burst.

**Via on your node.** If your node has `--via` on, every message APRScaching sends through it (acks,
replies, find confirmations) is forwarded only by the relays you listed. Recipients outside their range
don't receive it. The box logs the node's setting once it has seen the node send a message
(`[meshcom] node OE8APR-12 has Via on: …`), and the station status and the Pocket notification show it.
Until then it is unknown. APRScaching never changes the setting: that is `--via` on the node.

## 3. Firewall

Allow UDP 1799 into the box from the node's address only.

=== "ufw"

    ```
    sudo ufw allow from 192.168.1.50 to any port 1799 proto udp
    ```

=== "nftables"

    ```
    nft add rule inet filter input ip saddr 192.168.1.50 udp dport 1799 accept
    nft add rule inet filter input udp dport 1799 drop
    ```

The box enforces the same allowlist itself; the firewall keeps anything else from reaching it at all.

## How MeshCom traffic is trusted

A node reports four kinds of traffic, and the box treats them differently:

| The node… | Shown as | Can count toward Tier A? |
|---|---|---|
| heard the station **directly** over LoRa | heard on RF, received by your node | **Yes**, when your node's callsign is an attested site |
| heard it **through another node** (a relay) | heard on RF, no receiving site | No |
| got it from the **MeshCom server** over the internet | internet-sourced | No |
| sent it itself (its own position, messages, notices) | internet-sourced | No |

In plain words: MeshCom corroborates a find only when your own node heard the finder's station directly, and
only once you vouch for that node. Vouch for it on the gateway by adding its callsign to `FIRST_PARTY_SITES`
([Configuration](../../reference/configuration.md)). As with every receiver, your own node never
corroborates your own finds. Relays and server copies still show on the map and in the monitor; they prove
nothing about where a station was.

**Callsign verification** follows the same rule. A player's `VERIFY <code>` direct message to the service
call, from any SSID of their call, verifies the call only when your node heard it directly over
LoRa and the node's callsign is in `FIRST_PARTY_SITES`. A copy relayed by another node, or passed on by the
MeshCom server, is dropped without an answer and costs the player no attempt. The verification names your
node as the station that heard it. With [answering](#answering-radio-commands-optional) set up, the node
acks the message and confirms the verification. The player's steps are in
[Verify your callsign on the air](../../play/join.md#on-the-air).

## Check that it worked

- **Box log**: the `[meshcom] listening …` line above, and every ten minutes a counters line:

  ```
  [meshcom] stats {"received":412,"forwarded":377,"deduped":21,"upgraded":3,"rf":210,"udp":150,"own":17,"tele":14,"viaDropped":0,"rejected":{"not-json":2},"lastSeenAgoS":4}
  ```

  `deduped` counts frames the node reported twice (over LoRa and from the server); `upgraded` counts a LoRa
  copy that arrived after the server copy and was forwarded again as RF; `viaDropped` counts via-list
  tokens that were not callsigns (the message itself is kept). Message text is never logged.

- **Map**: MeshCom stations' positions, marked as MeshCom nodes, with how your node heard them and the links
  it heard ([MeshCom on the map](../../shack/live-map.md#meshcom-on-the-map)).
- **Message log**: direct messages between callsigns.
- **Port monitor**: every MeshCom frame on the `meshcom` port, including group and broadcast text. That
  text stays out of the message log because it is addressed to no one in particular.
- **`deploy/aprscaching doctor`**: when each node was last heard, and a warning for old firmware or for
  `MESHCOM_BIND=0.0.0.0` on a public host.

The box transmits on MeshCom only when [answering radio commands](#answering-radio-commands-optional) is
set up.

**KISS over TCP.** An ESP32 node with firmware 4.35t (built 2026-09-24 or later) also serves KISS on TCP port
8001, one client at a time. APRSdroid, Xastir or YAAC can use the node that way. The box keeps ExtUDP: it
carries the signal report and the sender's device, which KISS frames do not.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| `no local address on the subnet of …` | The box has no address on the node's network. Check `MESHCOM_NODE`, or set `MESHCOM_BIND`. |
| `udp/1799 … is already in use` | Another MeshCom program owns the port. Stop it, or let the box own the port and list the other program in `MESHCOM_FANOUT`. |
| `no datagram from … for N min` | The node is off the Wi-Fi, runs its own access point, or `--extudpip` points elsewhere. Check on the node with `--info`. |
| `rejected: {"not-allowlisted": …}` rising | The node's address changed (give it a DHCP reservation), or something else on the LAN sends to 1799. |
| The node restarts when ExtUDP is on | Firmware older than a 4.35t build of 2026-09-25: update it. |
| Players' `FOUND` messages never arrive | The instance's service call has no digit (`SERVICE_CALL`), or your node uses the service call's SSID and takes the messages as its own. |
| Positions but no Tier A | The node's callsign is missing from `MESHCOM_NODE=<ip>=<CALL>` or from the gateway's `FIRST_PARTY_SITES`, or the frames are relayed rather than heard directly. |

## Next

- [Packet: BBS & NET/ROM node](packet-node.md): a connected-mode node and BBS on the same box.
- [Receiving site and Tier A](rf-ingest.md#receiving-site-and-tier-a): the same rule for a TNC.
