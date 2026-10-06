# Packet terminal & BBS

This page shows you how to use the Shack's packet apps: connect to a BBS or a node over your own TNC, and send
mail through the instance's BBS. To decode a raw frame, use the packet decoder in
[Tools and plugins](tools.md#decode-a-packet). It is for operators who know packet radio; no server setup
is involved.

## Connect to a BBS or node

The **Packet terminal** is a multi-channel connected-mode terminal for a [KISS](../glossary.md#kiss) TNC on
USB or Bluetooth Low Energy, such as a Mobilinkd. It needs a Chromium-based browser: USB works on a computer,
Bluetooth on a computer or an Android phone. Browsers on an iPhone or iPad have neither.

!!! warning "Connecting transmits"
    A connect keys your radio under your callsign, so the terminal connects only for a verified callsign
    ([Verify your callsign](../play/join.md#verify-your-callsign)) and with your consent for this tab. Until
    then it listens: channel 0 shows everything your TNC hears. Read [On-air etiquette and rules](on-air.md)
    first.

1. Open **Shack → Packet terminal**.
2. Choose **USB** or **Bluetooth**, switch on or plug in the TNC, and select **Open KISS TNC…**. Pick the
   device in the browser's dialog. Channel 0 shows everything the TNC hears.
3. Answer **Allow** when the app asks whether this tab may transmit through the TNC. **Receive only** keeps it
   listening; **Allow transmit**, or the first **Connect**, asks again. The consent ends when you close the
   tab or the TNC, select **Receive only**, or sign out
   ([Allow transmitting for this tab](my-radio.md#allow-transmitting-for-this-tab)).
4. Type a callsign in **connect to…** and select **Connect**. The connection opens on a channel of its own.
5. Type a line and select **Send**.

Every frame the terminal sends lights **TX** on the radio chip in the top bar and joins **Recent
transmissions** in **Settings → My radio (browser)**, marked **Terminal**. **Close TNC** releases the TNC. **↓ .ans** saves the current pane as ANSI art.

### Tools on the terminal's sessions

A station can connect to you as well: the terminal accepts the call on a channel of its own while you may transmit.
The tools you run can then greet it, answer the commands they open to connected stations (such as `INFO` or
`NOTE <text>`), ring when it connects and time the link. On a session you opened, tools only listen. A tool's lines
go out under the same gate as yours and are marked with the tool's title in **Recent transmissions**
([Tools on connected sessions](tools.md#tools-on-connected-sessions)).

## Use the instance's BBS

The **BBS** app reads and writes the instance's mail store. Bulletins are open to everyone. Your mail needs
you signed in with an account that holds the callsign.

### Send mail

1. Open **Shack → BBS** and select **Compose**.
2. Choose the **Type**: **Personal**, **Bulletin** or **Traffic (NTS)**.
3. Enter **To**: a callsign, or `ALL`, `BLN…` for a bulletin.
4. Enter an optional **Subject** and the **Message**, then select **Send**.

Personal mail waits in the BBS until its addressee reads it here or by connecting to the packet BBS, or until
FBB forwarding passes it to the addressee's home BBS. FBB forwarding carries your mail only once your callsign
is verified; until then it stays on this BBS. It is never sent over APRS or MeshCom. **Sent** shows its
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
send, kill, help) over the same mail store as the **BBS** app. Both run on the instance's ingest box, so your
tools never answer on their sessions: the BBS and the node keep their own commands. The **BBS** and **NET/ROM node** apps
show the panels of tools that target them. The node's and the BBS's callsigns come from
the sysop; how they are set up is under [Packet: BBS & NET/ROM node](../run/radios/packet-node.md).

## Next

- [Messages over APRS and MeshCom](messages.md): live radio messages.
- [Rig control & weather](rig-weather.md): tune your radio.
