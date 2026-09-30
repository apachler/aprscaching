# MeshCom

[MeshCom](https://icssw.org/meshcom/) is a LoRa text-and-position mesh for licensed radio amateurs on
70 cm (433.175 MHz in Germany, Austria and Switzerland). A MeshCom node on your LAN can stream everything it
handles to your ingest box as JSON over UDP — the node's **ExtUDP** interface. The box puts MeshCom
positions on the map and direct messages in the message log, and it can count a direct hearing by your own
node toward Tier A.

This page sets that up. The protocol itself is in [MeshCom ExtUDP protocol](../reference/meshcom-extudp.md).

## What you need

- A MeshCom node that joins your Wi-Fi as a client (ExtUDP does nothing while the node runs its own access
  point).
- **Firmware 4.35t built on or after 2026-09-25, or newer.** Older firmware can crash an ESP32 node with
  ExtUDP switched on. The box warns once in its log when a node reports older firmware; for 4.35t it cannot
  tell the build date and says so.
- The ingest box (`apps/ingest`) on the same LAN as the node — a Pi, PC or mini-PC. The ExtUDP interface has
  no authentication, so the node and the box talk over your LAN only, never across the internet.

## 1. Point the node at the box

On the node's serial console, the MeshCom app, or its web page:

```
--setssid <your Wi-Fi name>
--setpwd <your Wi-Fi password>
--extudpip <the ingest box's LAN address>
--extudp on
```

The node sends to port **1799** on the box; the port is fixed in the firmware.

## 2. Tell the box about the node

In the ingest box's `.env`:

```
MESHCOM_NODE=192.168.1.50=OE8APR-12
```

- The address is the node's LAN address. Datagrams from any other address are dropped.
- `=OE8APR-12` is the node's own callsign. It is optional but recommended: it lets the box recognise the
  node's own frames, and it names the node as the receiving site of what it hears directly (see
  [trust](#how-meshcom-traffic-is-trusted)).
- Several nodes: separate them with commas, `192.168.1.50=OE8APR-12,192.168.1.51=OE8APR-13`.

Restart the box. Its log shows:

```
[meshcom] listening udp/1799 on 192.168.1.10 for 192.168.1.50 (OE8APR-12)
```

### Optional settings

| Variable | Default | What it does |
|---|---|---|
| `MESHCOM_BIND` | this host's address on the node's subnet | The local address to listen on. Leave it blank; set it only when the box has several addresses on that subnet. `0.0.0.0` listens on every interface and is logged as a warning — never use it on a host reachable from the internet. |
| `MESHCOM_FANOUT` | — | Other programs on the box that also want the node's datagrams (MeshcomWebDesk, gomeshcomd, Home Assistant…), as `host:port` pairs. Only one program can own port 1799; the box owns it and passes each accepted datagram on. |
| `MESHCOM_RATE` | `20` | Maximum datagrams per second accepted from one node. |
| `MESHCOM_STALE_MIN` | `30` | Minutes of silence after which the box warns that a node has gone quiet. |
| `MESHCOM_PORT` | `1799` | The local port. The node always sends to 1799; change this only behind your own relay. |

### Answering radio commands (optional)

Players can log a find by sending a MeshCom direct message such as `FOUND AC-1234` to `APRSCG`
([Log from your radio](../guides/caching.md#log-from-your-radio)). To let the box acknowledge those
messages — and send the instance's text replies — through the node that heard them, set on the box:

```
BOX_ID=pi-home
BOX_TX=1
MESHCOM_TX=1
MESHCOM_TX_CALL=OE8APR
```

The node transmits every message under its own call, so `MESHCOM_TX_CALL` must be your call — the base call
of the node's (`OE8APR-12` above). The box then logs `[meshcom] transmit enabled as OE8APR` and records each
send in its log (time, node, destination, size and outcome — never the text). Sends share a rate limit of
one per minute, three in a burst.

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

A node reports three kinds of traffic, and the box treats them differently:

| The node… | Shown as | Can count toward Tier A? |
|---|---|---|
| heard the station **directly** over LoRa | heard on RF, received by your node | **Yes** — when your node's callsign is an attested site |
| heard it **through another node** (a relay) | heard on RF, no receiving site | No |
| got it from the **MeshCom server** over the internet | internet-sourced | No |
| sent it itself (its own position, messages, notices) | internet-sourced | No |

In plain words: a find is corroborated by MeshCom only when your own node heard the finder's station
directly, and only once you vouch for that node. Vouch for it on the gateway by adding its callsign to
`FIRST_PARTY_SITES` (see [configuration](../reference/configuration.md)). As with every receiver, your own
node never corroborates your own finds.

Relays and server copies still show up on the map and in the monitor — they just prove nothing about where
a station was.

### Callsign verification over MeshCom

A player can verify their callsign from a MeshCom node: they tap **verify** in the app, get a code, and send
the MeshCom direct message `VERIFY <code>` to the service call (`APRSCG`) from any SSID of their call
([Verify your callsign](../guides/account.md#verify-your-callsign)). The same rule as above decides: the
message verifies the call only when your node heard it **directly** over LoRa and the node's callsign is in
`FIRST_PARTY_SITES`. A copy relayed by another node, or passed on by the MeshCom server, is dropped without
an answer and costs the player no attempt — they can still reach your node directly afterwards. The
verification names your node as the station that heard it. With [answering](#answering-radio-commands-optional)
set up, the node acks the message and confirms the verification.

## What you see

- **Map** — MeshCom stations' positions, marked as MeshCom nodes, with how your node heard them and the
  links it heard; see [MeshCom on the map](../guides/caching.md#meshcom-on-the-map).
- **Message log** — direct messages between callsigns.
- **Port monitor** — every MeshCom frame on the `meshcom` port, including group and broadcast text, which
  stays out of the message log because it is addressed to no one in particular.
- **Box log** — every ten minutes a counters line:

  ```
  [meshcom] stats {"received":412,"forwarded":377,"deduped":21,"upgraded":3,"rf":210,"udp":150,"own":17,"tele":14,"rejected":{"not-json":2},"lastSeenAgoS":4}
  ```

  `deduped` counts frames the node reported twice (over LoRa and from the server); `upgraded` counts a LoRa
  copy that arrived after the server copy and was forwarded again as RF. Message text is never logged.

The box does not transmit on MeshCom.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| `no local address on the subnet of …` | The box has no address on the node's network. Check `MESHCOM_NODE`, or set `MESHCOM_BIND`. |
| `udp/1799 … is already in use` | Another MeshCom program owns the port. Stop it, or let the box own the port and list the other program in `MESHCOM_FANOUT`. |
| `no datagram from … for N min` | The node is off the Wi-Fi, running its own access point, or `--extudpip` points elsewhere. Check on the node with `--info`. |
| `rejected: {"not-allowlisted": …}` rising | The node's address changed (give it a DHCP reservation), or something else on the LAN is sending to 1799. |
| The node restarts when ExtUDP is on | Firmware older than a 4.35t build of 2026-09-25 — update it. |
| Positions but no Tier A | The node's callsign is missing from `MESHCOM_NODE=<ip>=<CALL>` or from the gateway's `FIRST_PARTY_SITES`, or the frames are relayed rather than heard directly. |
