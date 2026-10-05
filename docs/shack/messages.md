# Messages over APRS and MeshCom

This page shows you how to write, read and answer APRS messages in APRScaching, and where MeshCom messages
appear. It is for operators with a callsign; at the end you can hold a conversation with another station and
know which surface handles which kind of message.

## Where messages appear

| Surface | What it holds |
|---|---|
| **Messages → Conversations** (signed in) | Your own messages, one conversation per station: write, reply, and choose how each message is delivered. |
| **Messages → On the air** | Every APRS text message the instance hears, from any station, and MeshCom direct messages. |
| **Messages → MeshCom groups** | MeshCom group chat the instance's MeshCom nodes heard. Read only. |
| **Settings → My radio (browser) → Local inbox** | The messages your own radio heard in this browser, with an **ACK** button for those addressed to you. |
| **Shack → BBS** | Mail and bulletins on the instance's packet BBS, moved the F6FBB way. Never sent over APRS or MeshCom. |
| **You → Logs sent over the air** | The commands you sent to the instance by radio, such as `FOUND`, waiting for you to confirm them. |

**Messages** is in the left rail, or under **More** on a phone. It is radio messaging, separate from the BBS: a
BBS message is never made from an APRS or MeshCom message, and never sent as one.

## Write and answer messages

Signed in, **Messages** opens on **Conversations**: one row per station you exchanged messages with, newest
first, with the last message and its state. Select a row to read the conversation and **Reply** at its foot.

Messages from people who erased their account, or who no longer hold the call they wrote from, gather under
**Withdrawn correspondents**. That conversation has no **Reply**: there is no station to answer.

### Before you start

- A [verified callsign](../play/join.md#verify-your-callsign). Every message goes out on the air under your
  callsign, so until it is verified the form is locked and says why.

### Steps

1. Select **New message**, or open a conversation to reply in it.
2. Enter **To**: a callsign such as `OE5XYZ`, or `OE5XYZ-7` for one station. The field suggests the stations
   you wrote with.
3. Enter the **Message**, up to 67 characters.
4. Choose the **Delivery**:
    - **Now** sends it at once. With a USB or Bluetooth TNC connected in
      [My radio](my-radio.md#connect) and transmit switched on, it goes out from your radio as your TX callsign.
      Otherwise the instance sends it to [APRS-IS](../glossary.md#aprs-is) under your callsign, through its
      ingest box. The line under the choice says which.
    - **When next heard** leaves it in the [Mailbox](#leave-a-message-in-the-mailbox): the instance sends it the
      next time it hears the station, for up to 7 days.
5. Select **Send** (or **Leave message**).

Each message carries a number, so the station's radio acknowledges it. The conversation shows its state:

| State | Means |
|---|---|
| **queued** | Waiting for the instance's ingest box to send it to APRS-IS |
| **sent** | Sent; no acknowledgement heard yet |
| **acked** | The instance heard the station acknowledge it |
| **not sent** | The instance could not send it within the hour |
| **waiting until heard**, **sent, no ack yet**, **delivered**, **sent, never acked**, **expired** | A Mailbox message: [What happens next](#what-happens-next) |

An ack counts only when the instance hears it: one your radio heard alone, without
[forwarding](my-radio.md#send-what-you-hear-to-an-instance), leaves the message **sent**.

## Read the messages the instance hears

1. Open **Messages** and switch the view to **On the air**.
2. The list shows the newest messages first, each with sender, recipient, age and the network that carried it.
   A message from or to your callsign (any [SSID](../glossary.md#ssid)) is highlighted and offers **Reply**,
   which opens your conversation with the other station. **Load more** shows older ones.
3. To read only your own traffic, select **Mine**: the list keeps the messages from or to any SSID of your
   callsign. **All** shows everything again.

The list holds what the instance heard over the air, from [APRS-IS](../glossary.md#aprs-is) and from
[MeshCom](../glossary.md#meshcom), and the messages you sent from your radio in the browser or from your remote
box, marked **sent**. A MeshCom message to a callsign is listed like an APRS message; a message to a MeshCom group
is not. Acknowledgements are not
listed. When nothing has arrived yet, the list says so.

### Which network carried a message

A badge on each message names the network it came in on, or went out on:

| Badge | Means |
|---|---|
| **RF** | Heard on the air by a TNC on the instance's ingest box, or sent by your remote box |
| **Browser radio** | Heard or sent by a radio connected to a browser |
| **MeshCom** | Heard through a MeshCom node on the instance's ingest box |
| **Meshtastic** | Heard through Meshtastic |
| **APRS-IS** | Received from APRS-IS, over the internet |
| **AXUDP**, **AXIP** | Received over an internet link between packet nodes |
| **Other** | Received on a port the instance does not know |

The edge of the badge takes the map's colour for on the air, the internet or a mesh, so the families stand
apart at a glance. The network says how a message arrived, not who sent it: anyone can put a message on
APRS-IS. A message stored without its network shows no badge.

## Send an APRS message from your radio

### Before you start

- A [verified callsign](../play/join.md#verify-your-callsign).
- A USB or Bluetooth TNC connected in **Settings → My radio (browser)**
  ([Your radio in the browser](my-radio.md#connect)). The soundcard and Meshtastic links receive only.

### Steps

1. In **Settings → My radio (browser)**, switch on **Enable transmit**. From **Messages**, **Open My radio**
   takes you there.
2. Check the **TX callsign** SSID, `-7` by default.
3. Under **Message**, enter the recipient's callsign in **to** (up to nine characters) and the text in
   **message** (up to 67 characters).
4. Select **Send**, then **Transmit** in the confirmation.

The app shows **Transmitted: message to <CALL>**. The message goes out with the path `WIDE1-1` and a message
number, so the recipient's station acknowledges it. It joins the **Messages** list, marked **sent**.

## Acknowledge a message sent to you

The **Local inbox** in the **Field station** panel lists the messages your radio heard, newest first. When a
message to your callsign carries a message number, and transmit is on, the row shows **ACK** and that
number.

1. Select **ACK <number>**.
2. The app shows **ACK <number> → <CALL>** once your radio has sent it.

The browser never acknowledges on its own: each ack is a transmission you choose to make.

## MeshCom direct messages

When the instance runs a [MeshCom](../glossary.md#meshcom) node, a direct message between two callsigns that
the node receives appears in **Messages** like an APRS message. Group and broadcast text (`*` or a group
number) is addressed to no one in particular and stays out of the list: it has its own view.

## Read MeshCom group chat

When the instance's MeshCom nodes have heard a group message, **Messages** adds a **MeshCom groups** view beside
**Conversations** and **On the air**. Without one, the view is not there.

1. Open **Messages** and switch the view to **MeshCom groups**.
2. Pick a **Group**. Each group shows how many messages the instance keeps; **All (\*)** is the group every
   node reads.
3. The newest messages come first, each with sender, age, and the node that heard it and how: **heard
   directly**, **relayed on the mesh** or **from the MeshCom server**. **Load more** shows older ones.

A message heard by several nodes, or twice, is listed once. The instance keeps group messages as long as the
other messages, 7 days unless its sysop changes that. The view is read only.

You cannot write a MeshCom message in the app: write it on your own MeshCom node. The instance sends MeshCom
messages only from its service call: answers to commands, Mailbox messages and near-cache messages, through the
node that heard the station, when its sysop allows that ([MeshCom](../run/radios/meshcom.md)). A direct
message to the service call is a command (below).

## Leave a message in the Mailbox

The Mailbox holds a short message for a station until the instance hears it on the air, then sends it as an
APRS message from the instance's [service call](../glossary.md#service-call). It is separate from the BBS: a
Mailbox message never becomes BBS mail, and the BBS never sends over APRS.

### Before you start

- You're signed in, and your callsign is verified: the instance puts your text on the air in your name.

### Steps

1. Open **Messages**, select **New message** (or open the conversation with the station), and choose
   **When next heard** under **Delivery**.
2. Enter **To**: a callsign such as `OE5XYZ`, or `OE5XYZ-7` for one station.
3. Enter the **Message**. It goes out as `de <your call>: <text>`, so it holds up to 67 characters with that
   prefix.
4. Select **Leave message**.

From your radio, send `MAIL OE5XYZ <text>` to the service call instead. A copy heard only over the internet
waits under **You → Logs sent over the air** until you confirm it.

### What happens next

Mail to a base call goes to whichever of its stations the instance hears first; mail to `OE5XYZ-7` waits for
that station. The station's radio acknowledges the numbered message. The conversation shows each message's state:

| State | Means |
|---|---|
| **waiting until heard** | Not heard yet |
| **sent, no ack yet** | Sent; the instance tries again when it hears the station, at most once a minute |
| **delivered** | The station acknowledged it |
| **sent, never acked** | Sent five times without an ack |
| **expired** | Not heard within 7 days |

**Withdraw** takes back a message that is still waiting or unacknowledged. A message left for you shows in the
conversation with its sender, **waiting until heard**, until the instance hears your station. A station heard on
MeshCom gets its messages through the node that heard
it. Only when that node is the sysop's own, reached over KISS, does the message come from the service call
with a number the station acks; otherwise it goes out once, under the node's call, and shows **sent, never
acked**.

## Commands you send by radio

A message to the instance's service call is a command, whether it travels over APRS or as a MeshCom direct
message:

| Message | Does |
|---|---|
| `FOUND <code>`, `DNF <code>`, `NOTE <code> <text>` | Logs a find, a did-not-find or a note: [Log from your radio](../play/log-a-find.md#log-from-your-radio) |
| `MAIL <call> <text>` | Leaves a message in the [Mailbox](#leave-a-message-in-the-mailbox) for that station |
| `NEAR ON`, `NEAR OFF` | Switches the radio message you get near a cache: [The "you're near" prompt](../play/find-a-cache.md#the-youre-near-prompt) |
| `HELP` | Replies with the command list |
| `VERIFY <code>` | Completes your callsign verification: [On the air](../play/join.md#on-the-air) |

A command heard only over the internet waits under **You → Logs sent over the air** until you confirm it.

## Field alerts on Pocket

A [Pocket](../run/install/pocket.md) phone can vibrate within 15 seconds when a new direct message reaches
the phone's own callsign, any SSID, over MeshCom or APRS. It can also say who sent the message, and read the
text aloud only when you allow that, since a phone speaks to everyone around it. Field alerts are off by
default; [Pocket extras](../run/pocket/extras.md) turns them on.

## Next

- [Rig control & weather](rig-weather.md): tune your radio, report your weather station.
- [On-air etiquette and rules](on-air.md): before you transmit.
