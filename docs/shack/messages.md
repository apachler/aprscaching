# Messages over APRS and MeshCom

This page shows you where APRS and MeshCom text messages appear in APRScaching, and how you send and
acknowledge them. It is for operators with a radio; at the end you know which surface handles which kind of
message.

## Where messages appear

| Surface | What it holds |
|---|---|
| **Messages** in the left rail, or **More → Messages** on a phone | Every APRS text message the instance hears, from any station, and MeshCom direct messages. Read only. |
| **Settings → My radio (browser) → Local inbox** | The messages your own radio heard in this browser, with an **ACK** button for those addressed to you. |
| **Shack → BBS** | Mail and bulletins on the instance's packet BBS, moved the F6FBB way. Never sent over APRS or MeshCom. |
| **You → Logs sent over the air** | The commands you sent to the instance by radio, such as `FOUND`, waiting for you to confirm them. |

**Messages** is radio messaging, separate from the BBS: a BBS message is never made from an APRS or MeshCom
message, and never sent as one.

## Read the messages the instance hears

1. Select **Messages** in the left rail. On a phone, select **More**, then **Messages**.
2. The newest messages come first, each with sender, recipient and age. A message from or to your callsign
   (any [SSID](../glossary.md#ssid)) is highlighted. **Load more** shows older ones.
3. To read only your own traffic, select **Mine**: the list keeps the messages from or to any SSID of your
   callsign. **All** shows everything again.

The list holds what the instance heard over the air and from [APRS-IS](../glossary.md#aprs-is), and the messages
you sent from your radio in the browser or from your remote box, marked **sent**. Acknowledgements are not
listed. When nothing has arrived yet, the list says so.

## Send an APRS message from your radio

### Before you start

- A [verified callsign](../play/join.md#verify-your-callsign).
- A USB or Bluetooth TNC connected in **Settings → My radio (browser)**
  ([Your radio in the browser](my-radio.md#connect)). The soundcard and Meshtastic links receive only.

### Steps

1. In **Settings → My radio (browser)**, switch on **Enable transmit**. From **Messages**, **Open Settings**
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
number) is addressed to no one in particular and stays out of the list.

APRScaching does not send MeshCom messages for you: write them on your own MeshCom node. A direct message to
the instance's service call is a command (next section). The instance answers it through the node that heard
it when its sysop allows that ([MeshCom](../run/radios/meshcom.md)).

## Commands you send by radio

A message to the instance's service call is a command, whether it travels over APRS or as a MeshCom direct
message:

| Message | Does |
|---|---|
| `FOUND <code>`, `DNF <code>`, `NOTE <code> <text>` | Logs a find, a did-not-find or a note: [Log from your radio](../play/log-a-find.md#log-from-your-radio) |
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
