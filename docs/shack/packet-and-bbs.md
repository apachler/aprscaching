# Packet terminal & BBS

This page shows you how to use the Shack's packet apps: decode a frame, connect to a BBS or a node over your
own TNC, and send mail through the instance's BBS. It is for operators who know packet radio; no server setup
is involved.

## Decode a packet

1. Open **Shack → Packet decoder**.
2. Paste a line in the usual TNC2 format, for example:

    ```
    OE8APR-9>APRS,WIDE1-1,qAR,OE8XBM-10:!4703.00N/01526.00E>mobile
    ```

The decoder shows what the line contains: position (plain, compressed or Mic-E), course, speed, altitude,
objects and items, messages with acknowledgements, bulletins, status, weather and telemetry. In the example,
`qAR,OE8XBM-10` is the [q-construct](../glossary.md#q-construct): where the packet entered APRS-IS.

## Connect to a BBS or node

The **Packet terminal** is a multi-channel connected-mode terminal for a [KISS](../glossary.md#kiss) TNC on
USB or Bluetooth Low Energy, such as a Mobilinkd. It needs a Chromium-based browser: USB works on a computer,
Bluetooth on a computer or an Android phone. Browsers on an iPhone or iPad have neither.

!!! warning "Connecting transmits"
    A connect keys your radio under your callsign, so the terminal connects only for a verified callsign
    ([Verify your callsign](../play/join.md#verify-your-callsign)). Until then it listens: channel 0 shows
    everything your TNC hears. Read [On-air etiquette and rules](on-air.md) first.

1. Open **Shack → Packet terminal**.
2. Choose **USB** or **Bluetooth**, switch on or plug in the TNC, and select **Open KISS TNC…**. Pick the
   device in the browser's dialog. Channel 0 shows everything the TNC hears.
3. Type a callsign in **connect to…** and select **Connect**. The connection opens on a channel of its own.
4. Type a line and select **Send**.

**Close TNC** releases the TNC. **↓ .ans** saves the current pane as ANSI art.

## Use the instance's BBS

The **BBS** app reads and writes the instance's mail store. Bulletins are open to everyone. Your mail needs
you signed in with an account that holds the callsign.

### Send mail

1. Open **Shack → BBS** and select **Compose**.
2. Choose the **Type**: **Personal**, **Bulletin** or **Traffic (NTS)**.
3. Enter **To**: a callsign, or `ALL`, `BLN…` for a bulletin.
4. Enter an optional **Subject** and the **Message**, then select **Send**.

Personal mail waits in the BBS until its addressee reads it here or by connecting to the packet BBS, or until
FBB forwarding passes it to the addressee's home BBS. It is never sent over APRS or MeshCom. **Sent** shows its
state: **read**, **forwarded to** a partner BBS, or **waiting**. Bulletins also reach the instances this one
federates with.

### Read mail and bulletins

1. Select **Inbox** or **Bulletins**. Unread mail carries a dot.
2. Select a message to read it, with its sender, recipient, BID and date. A thread shows all its messages.
3. Select **Reply** to answer in the same thread.

## The instance's node and connected-mode BBS

When the sysop runs a [NET/ROM](../glossary.md#netrom) node or the connected-mode BBS, you reach them with the
**Packet terminal** like any other station. Connect to the node's callsign or alias, and use `C <callsign>` at
its prompt to go on to another station. The connected-mode BBS answers with the F6FBB command set (list, read,
send, kill, help) over the same mail store as the **BBS** app. The node's and the BBS's callsigns come from
the sysop; how they are set up is under [Packet: BBS & NET/ROM node](../run/radios/packet-node.md).

## Next

- [Messages over APRS and MeshCom](messages.md): live radio messages.
- [Rig control & weather](rig-weather.md): tune your radio.
