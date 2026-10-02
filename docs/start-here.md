# Start here

aprscaching is a treasure hunt for radio amateurs. Someone **hides a cache** — a spot on the map tied to
amateur radio: a summit, a park, a castle, a bench with a view. You **go there and log the find**. What makes
it different from ordinary geocaching is that a find can be **confirmed by radio**: if your [APRS](glossary.md#aprs) beacon was
heard on the air near the cache, the find counts as radio-verified.

Around the game sits **the Shack**: packet-radio tools in your browser — a live station map, an APRS
decoder, a packet terminal and BBS, rig control, and a bridge that connects your own radio to the platform.

You need an amateur-radio callsign to take part. You do **not** need to install anything or know anything
about software. A term you don't know is explained in a line or two in the [Glossary](glossary.md).

## Pick your path

| I want to… | Go to |
|---|---|
| **Play** — find and hide caches | [Play in five minutes](#play-in-five-minutes) below |
| **Connect my radio** to the map from my browser | [Your radio in the browser](guides/my-radio.md) |
| **Run my own instance** — for my club, my region, or off-grid | [Run your own instance](#run-your-own-instance) below |

## Play in five minutes

Everything below happens in your web browser — on your phone or your computer. Open
**[aprscaching.net](https://aprscaching.net)** (or the address of your club's instance).

1. **Sign in.** Tap **Sign in** (top right), type your callsign, tap **Continue**. On first visit, tap
   **Create account with a [passkey](glossary.md#passkey)** — your phone or computer stores the key; there is no password. You can
   add an email address for recovery, or use **Email me a link** instead of a passkey.

    ![Sign in with your callsign](assets/shots/signin-mobile.webp){ width="280" loading=lazy }
2. **Verify your callsign.** Open **You** and tap **Verify callsign** under your call (it opens
   **Settings → Account**, where **verify** sits next to each callsign you hold). The
   default is **On the air**: the app shows a message to send, such as `VERIFY 482913` to `APRSCG`. Transmit
   it within 30 minutes as an APRS message from your radio or a [MeshCom](glossary.md#meshcom) message from your node; your callsign
   is verified once this instance's own receiving station hears it directly on the air. You can instead
   publish a code under your `<call>.ampr.org` name, or sign with your ARRL [LoTW](glossary.md#lotw) callsign certificate — and
   a [sysop](glossary.md#sysop) can verify you by hand. Details: [Your account](guides/account.md#verify-your-callsign).
3. **Find a cache.** Browse the map, or tap **Nearby** for the closest caches. Tap one to open it: you see
   its description, difficulty and terrain, the hint, and **Navigate** to hand the coordinates to your maps
   app.

    ![A cache sheet on a phone](assets/shots/detail-mobile.webp){ width="280" loading=lazy }
4. **Log it.** At the spot, tap **✓ Log a find**. Allow location access when your browser asks — that is
   how the app confirms you were there. The result shows how well the find is verified (see below).
5. **Hide your own.** Tap **+ Hide a cache** (or **Hide** on a phone). On a phone the pin starts at your
   location; otherwise tap or click the map where it is (or **Use my location**). Give it a
   title, type, difficulty and terrain, and tap **Hide cache**.

More in [Caching](guides/caching.md).

### How finds are verified

Every find gets a badge: **Radio-verified** (A) when your APRS position was heard **on the air** near the
cache by a receiving station the instance runs and that isn't yours, **Location-verified** (B) when your
phone's location matched the cache, or **Logged** (C) when nothing independent placed you there. A position
that only travelled over the internet ([APRS-IS](glossary.md#aprs-is)) proves nothing about where you were,
so it can never count as more than tier C. [Log a find](guides/caching.md#log-a-find) shows each badge. Most finds are tier B; tier A appears wherever operators run their own receivers and
vouch for them. The full rules are in [Core concepts](concepts.md).

## Connect your radio

If you have a radio with a [TNC](glossary.md#tnc) — a USB or Bluetooth [KISS](glossary.md#kiss) TNC, a Mobilinkd, or only an audio cable to your
computer's soundcard — you can feed what your radio hears into the platform straight from a Chrome or Edge
browser, with no server. See [Your radio in the browser](guides/my-radio.md).

## Run your own instance

A club or a single operator can run a complete aprscaching instance: the map, the game, the Shack and a
radio gateway, on a Raspberry Pi at home, a small cloud server, or entirely off-grid. Instances can link up
with each other so caches and radio confirmations are shared across the network.

1. [Deployment](operate/deployment.md) — choose a setup: the desktop app, self-host (a Pi, a mini-PC or a
   cloud server), or Cloudflare.
2. [Running in Docker](operate/docker.md) — the usual way to install it; `deploy/setup.sh` writes the whole
   configuration.
3. [Your first hour as sysop](operate/first-hour.md) — the checklist from "it starts" to a public instance.
4. [RF ingest & transports](operate/rf-ingest.md) — connect a TNC, an [IGate](glossary.md#igate), [Meshtastic](glossary.md#meshtastic) or MeshCom.

Before you transmit anything automatically (IGate, [digipeater](glossary.md#digipeater), node), read
[Amateur-radio compliance](operate/rf-regulatory.md).
