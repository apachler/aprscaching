# Start here

aprscaching is a treasure hunt for radio amateurs. Someone **hides a cache** — a spot on the map tied to
amateur radio: a summit, a park, a castle, a bench with a view. You **go there and log the find**. What makes
it different from ordinary geocaching is that a find can be **confirmed by radio**: if your APRS beacon was
heard on the air near the cache, the find counts as radio-verified.

Around the game sits **the Shack**: packet-radio tools in your browser — a live station map, an APRS
decoder, a packet terminal and BBS, rig control, and a bridge that connects your own radio to the platform.

You need an amateur-radio callsign to take part. You do **not** need to install anything or know anything
about software.

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
   **Create account with a passkey** — your phone or computer stores the key; there is no password. You can
   add an email address for recovery, or use **Email me a link** instead of a passkey.

    ![Sign in with your callsign](assets/shots/signin-mobile.webp){ width="280" loading=lazy }
2. **Verify your callsign.** Go to **Settings → Account** and tap **verify** next to your callsign. The
   instance sends an APRS message to your callsign with a six-digit code (`aprscaching code 123456`, from
   `APRSCG`). Read it on your radio — or, if no IGate near you passes messages to RF, on
   [aprs.fi](https://aprs.fi) under *Messages* — and type it in within 15 minutes. Details:
   [Your account](guides/account.md).
3. **Find a cache.** Browse the map, or tap **Nearby** for the closest caches. Tap one to open it: you see
   its description, difficulty and terrain, the hint, and **Navigate** to hand the coordinates to your maps
   app.

    ![A cache sheet on a phone](assets/shots/detail-mobile.webp){ width="280" loading=lazy }
4. **Log it.** At the spot, tap **✓ Log a find**. Allow location access when your browser asks — that is
   how the app confirms you were there. The result shows how well the find is verified (see below).
5. **Hide your own.** Tap **+ Hide a cache** (or **Hide** on a phone), click the map where it is, give it a
   title, type, difficulty and terrain, and tap **Hide cache**.

More in [Caching](guides/caching.md).

### How finds are verified

Every find gets a badge:

| Badge | Tier | What it means |
|---|---|---|
| **Verified · RF** | A | Your APRS position was heard **on the air** near the cache by a receiving station that isn't yours. |
| **Verified · App** | B | Your phone's location, taken when you logged, matched the cache. |
| **Verified · C** / **Logged · unverified** | C | Only an internet (APRS-IS) position was available — the find is logged but not confirmed. |

A position that only travelled over the internet proves nothing about where you were, so it can never count
as more than tier C. Most finds are tier B; tier A appears wherever operators run their own receivers and
vouch for them. The full rules are in [Core concepts](concepts.md).

## Connect your radio

If you have a radio with a TNC — a USB or Bluetooth KISS TNC, a Mobilinkd, or just an audio cable to your
computer's soundcard — you can feed what your radio hears into the platform straight from a Chrome or Edge
browser, with no server. See [Your radio in the browser](guides/my-radio.md).

## Run your own instance

A club or a single operator can run a complete aprscaching instance: the map, the game, the Shack and a
radio gateway, on a Raspberry Pi at home, a small cloud server, or entirely off-grid. Instances can link up
with each other so caches and radio confirmations are shared across the network.

1. [Deployment](operate/deployment.md) — choose a setup (Pi at home, cloud server, desktop app).
2. [Running in Docker](operate/docker.md) — the usual way to install it.
3. [Your first hour as sysop](operate/first-hour.md) — the checklist from "it starts" to a public instance.
4. [Radio transports](operate/rf-ingest.md) — connect a TNC, an IGate, Meshtastic or MeshCom.

Before you transmit anything automatically (IGate, digipeater, node), read
[Amateur-radio compliance](operate/rf-regulatory.md).
