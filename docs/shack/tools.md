# Tools and plugins

This page shows you how to use the Shack's **Tools** app: install a tool from the registry, decode a packet, pin a
tool to the rail, and install a plugin someone else wrote. It is for operators; you need no server access. At the
end you know what a tool may do on your behalf and how to take it away again.

## Before you start

- Open **Shack → Tools** (on a phone: **More → Shack → Tools**).
- For tools that transmit: a [verified callsign](../play/join.md#verify-your-callsign) and a radio connected
  to this tab ([Your radio in the browser](my-radio.md)).

## What a tool is

A tool adds one job to the Shack: a decoder, a few `/commands`, a small panel, colours in the packet monitor, or
markers on the map. The app ships with none: you install the tools you want, from a registry or by a `tool.json`
address, and each runs in a sealed sandbox, apart from your session. A new player starts with no tools installed.

Each tool's row shows where it appears (**surfaces**: this Tools screen, the packet terminal, the BBS, the node or
the map) and the permissions it holds (**perms**).

## The project's tools

The **APRScaching tools** registry, which comes with every instance, lists the project's own tools: decoders,
monitor and station tools, responders, transmit tools and utilities. The [tool catalogue](https://apachler.github.io/aprscaching-tools/catalogue/) describes
each one, with the permissions it asks for.

## Install a tool

1. Under **Registry**, find the tool (type in **Find a tool** to narrow the list) and select **Install…**. Or
   paste a tool's `tool.json` address under **Install by address** and select **Install…**.
2. Read the prompt: who wrote the tool, the permissions it asks for, where it appears, the addresses it may
   reach, and its trust label.
3. Select **Approve and install**, or **Cancel**. The app fetches the tool's code and runs it only when the code
   matches the hash in the signed manifest; otherwise it says **the tool's code does not match its signed
   manifest** and installs nothing.

The tool appears under **Your tools**, switched on, with its own switch, pin and **Remove** button. Its listing in
the registry says **Installed**.

Your installed tools stay installed: they start again when you reload the page, and when you are signed in they
follow your account to another device. Each start checks the tool again: its signature under the author key you
approved, its code against the signed hash, and its permissions, network addresses and remote use against the
ones you approved. A tool that fails a check stays in **Your tools** with **Not running** and the reason. If its
author signed with a new key, or the tool now asks for more, install it again from the registry to approve the
change.

Installed tools belong to you. When you sign out, or someone else signs in on the same browser, your tools stop and
leave that browser; your account keeps them for your next sign-in.

## Switch a tool on or off

Turn the switch on a tool's row. A tool switched on shows its panel, decoder or commands: decoders and commands in
the **Decode** and **Run a tool command** sections, panels under **Your tools**, monitor colours in the packet
terminal. A tool switched off does not run at all: it stops, its beacon ends and its pin leaves the rail. The app
remembers the switch.

## Decode a packet

1. Install **Packet decoder** from the registry. The **Decode** section appears with **APRS packet** selected.
2. Paste a line in TNC2 format, or select **Use a sample**, for example:

    ```
    OE8APR-9>APRS,WIDE1-1,qAR,OE8XBM-10:!4703.00N/01526.00E>mobile
    ```

3. Select **Decode**.

The decoder answers with a one-line summary, and the **Packet decoder** panel shows the decode: the sender, the
destination and path, whether the line says it was heard on **RF** or came over **APRS-IS**, the packet type, and
every field: position (plain, compressed or Mic-E), course, speed, altitude, objects and items, messages with
acknowledgements, bulletins, status, weather and telemetry. In the example, `qAR,OE8XBM-10` is the
[q-construct](../glossary.md#q-construct): where the packet entered APRS-IS. The decoder runs in your browser, so
it works without a connection.

## Pin a tool to the rail

1. Select the pin button on the tool's row (**Pin Packet decoder to the rail**).
2. The tool appears on the left rail, below the Shack apps you pinned, with its icon. On a phone it is in
   **More**. A tool from outside the project registry shows a plug icon and its title.
3. Select it on the rail to open **Tools** with that tool switched on and in view; a decoder opens ready to paste.

Select the pin again (**Unpin …**) to take it off. Your pins are kept in this browser and, when you are signed in,
with your account, so another device shows them too. A pin shows while its tool runs, and goes when you switch the
tool off or remove it. A link to a tool you have not installed opens **Tools** on the registry, filtered to it.

## What each permission means

| Permission | The tool may |
|---|---|
| `panel` | Show a small panel of text, tables and bars. It cannot draw anything else on the page. |
| `command` | Answer `/commands` you type, here or in the terminal and BBS. |
| `monitor` | Read the frames your radio hears, and colour or hide lines in the packet monitor. |
| `decoder` | Add a decoder to the **Decode** list. |
| `event` | React when a station connects, a frame is heard, or a minute passes. |
| `map` | Put markers on the map. |
| `ipc` | Talk to other tools you run: share what it learns and ask them questions. |
| `network` | Reach the internet, and only the addresses the prompt lists under **connects to**. Without this permission it reaches nothing. |
| `beacon` | Schedule a beacon under your callsign. |
| `tx` | Ask to transmit under your callsign. |
| `geo` | Read your device's location. |

A tool never sees your session, your passkeys or the keys this browser holds for you, and no permission lets it
change how finds are verified.

Transmitting is gated three ways. The tool needs the `tx` or `beacon` permission; the app checks that your
callsign is [verified](../play/join.md#verify-your-callsign) each time the tool asks; and the frame goes out only
over the radio you connected in [**My radio**](my-radio.md), with your
[consent for this tab](my-radio.md#allow-transmitting-for-this-tab).
A tool never asks for that consent itself: without it, the tool's transmission is held and the app says so. A tool
transmits only APRS status and messages, which the install prompt states: **May transmit status and messages under
your callsign**. Every frame a tool sends shows in **Recent transmissions** under the tool's name and flashes the
transmit indicator. The app lets each tool transmit at most once a minute and six times an hour, beacons and
scheduled queries included, and a beacon at most every 10 minutes. A beacon ends when you disconnect the radio, your
consent ends, you sign out or change callsign or SSID; the tool has to schedule it again. A scheduled query connects
through the packet terminal's TNC, under that terminal's consent.

## The trust labels

| Label | Meaning | What to do |
|---|---|---|
| **Signed · registry-listed author key** | The registry lists this tool at this address, and the author key it lists signed the manifest. | Install if the permissions fit the job. |
| **Signed · matches the key you trusted before** | You accepted this author's key before, from another tool or an earlier install. | Install if the permissions fit the job. |
| **Signed · unknown author key (trust-on-first-use)** | Signed, but nobody vouches for the key. Approving remembers it for this author. | Install only if you trust where the address came from. |
| **Unsigned — refused** | No signature. | Blocked. Ask the author for a signed release. |
| **Author key CHANGED since you last trusted it — refused** | The author's key is not the one you accepted, or not the one the registry lists. | Blocked. Ask the author, through a channel you trust, whether they changed their key. |
| **Signature INVALID — refused** | The manifest was changed after it was signed. | Blocked. Do not look for another copy; tell the author. |

A signature covers the manifest, and through its `entrySha256` the exact bytes of the script. A label vouches for
who signed the tool, not for what the script does; the permissions are what limit it.

After a key-change warning, the app keeps refusing that author's new key. If the author confirms the change,
remove the old key: clear this site's data in your browser's settings. That also clears your pins, settings
and offline areas on this device.

## The Registry list

**Registry** lists the tools of every registry switched on for you, one group per registry. Each group shows the
registry's name, whose it is (**instance**: set up by the sysop; **yours**: added by you, not checked by this
instance) and the fingerprint of its key. A group can show:

| State | Meaning |
|---|---|
| A list of tools | The registry verified under its pinned key. |
| **The registry's host can't be reached; this is the copy this instance kept** | The instance serves its last good copy. |
| **Couldn't load …** with **Retry** | The registry can't be fetched now. The other groups are not affected. |
| **… failed its signature check** | The file was changed without its key. Its tools stay hidden. |
| **Key changed** | The registry is now signed by another key. Its tools stay hidden until whoever added it compares and confirms the new key. |

A tool that several registries list shows once, under the first, with **Listed by** naming each.

## Add a registry

When the sysop allows it, you can add registries of your own: a club's tools, or a friend's. You need to be signed
in, and you can add up to ten.

1. Open **Your registries** below the Registry list.
2. Enter the registry's address: `github:owner/repo`, `github:owner/repo@v1.0.0` for one tagged release, a GitHub
   Pages address, or any `https://` address. Add a label if you like.
3. Select **Fetch and show its key**. The app shows the key's fingerprint, how many tools the registry lists and a
   few of their titles.
4. Compare the fingerprint with the one the publisher gives: in their README, on their site, or in person. Select
   **It matches: pin and add** only if every digit matches.

The registry's group appears under **Registry**, marked **yours**. Your registries are kept with your account, so
they follow you to another device, and they are part of your account's data export and erasure. Switch one off, or
**Remove** it, in **Your registries**.

If the group shows **Key changed**, the publisher signed with a new key, or someone else did. Ask the publisher,
through a channel you trust, for the new fingerprint, then select **Compare and confirm the new key…** and confirm
only if it matches.

If the sysop stops players adding registries, yours are hidden and not fetched, but kept until you remove them or
the sysop allows them again.

## Remove a tool

Select **Remove** on its row and confirm. The tool stops, its sandbox closes, its pin leaves the rail and it is no
longer installed, on this device and on the others your account reaches. Install it again from the registry
whenever you like.

## Where tools keep data

Tools keep their data in this browser; your installed tools, your pins and your own registries go with your
account:

- A tool's own notes (watched calls, heard stations, away notes) live in memory and end with the page.
- Your installed tools (each one's address, the author key and the permissions you approved, and its switch) and
  your pins live in this browser and, when you are signed in, with your account.
- The author keys you accepted live in this browser's storage. Clearing this site's data removes them.
- The registries you added live with your account, in its data export and erasure.

## Stay safe

Tools run in your browser, sandboxed, never on the instance. A tool reaches what you grant it and nothing else:
`tx`, `beacon`, `network` and `geo` each need your approval, and transmitting also needs your verified callsign and
your transmit consent for the tab. A registry, even one the sysop set up, vouches for who signed a tool, not for
what it does.

- Grant only the permissions a tool needs for its job. A unit converter has no reason to ask for `network`.
- Check every address under **connects to**. A tool can send what it sees to those addresses.
- Prefer registry-listed tools, and install others only from an author you know.
- Add a registry only after comparing its fingerprint with the publisher's.
- Take a key-change warning seriously: it is the one sign that someone else may be signing as the author.
- Remove a tool you no longer use.

## Next

- [Packet terminal & BBS](packet-and-bbs.md): where most tools show their colours and commands.
- [Tool catalogue](https://apachler.github.io/aprscaching-tools/catalogue/): every tool in the project registry.
