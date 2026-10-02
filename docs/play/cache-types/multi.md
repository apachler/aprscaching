# Multi-stage caches

This page is for players and hiders. It explains the multi-stage cache: a chain of stages, where each stage
you unlock shows you where the next one is.

## What it is

A multi-stage cache has an open start and a chain of locked stages. Each stage hides its position until you
unlock it. You unlock stages in order, one after another.

## How you find it

Open the cache. The **Stages** section shows how far you are, for example **Stages · 1/3 unlocked**. **Start**
is open to everyone. Each later stage shows a lock and how it unlocks. When you unlock a stage, its
coordinates, its clue and a **map ↗** link appear. An audio stage shows its clip and clue while it is still
locked, because working them out is how you open it. Any other stage's clip plays once you unlock it: tap
**Play stage <number> clip**.

Each stage unlocks in one of four ways:

| Unlock | What you do | What the game checks |
|---|---|---|
| geo | Stand at the stage you have, then tap **I'm here — reveal**. | Your phone is within the radius of the stage you stand at. The radius is 60 m unless the hider sets another. |
| nfc | Tap **Scan NFC tag** and hold the phone to the tag. Or type the code printed on the tag and tap **Unlock**. | The code matches. Case and spaces around it do not matter. |
| audio | Listen to the clue, then tap **Reveal next stage**. | Nothing: the stage opens when you ask. |
| open | Follow the clue, then tap **Reveal next stage**. | Nothing: the stage opens when you ask. |

```mermaid
flowchart LR
  S["Start (open)"] -->|unlock| S1["Stage 1"]
  S1 -->|unlock| S2["Stage 2"]
  S2 -->|"…"| F["Last stage"]
```

You need to be signed in to unlock a stage. A stage stays locked until you have unlocked the one before it.

- **Too far:** a geo stage says how far away you are, for example **Too far — 85 m away.**
- **Wrong code:** an NFC stage says **That tag/code doesn't match this stage.** You get 10 tries per hour on a
  tag.
- **No NFC reader:** scanning works in Chrome on Android. On other devices, type the code.

## What "found" means

You unlocked every stage and were at the last one when you logged. A find needs the last stage unlocked;
before that, **✓ Log a find** answers that the stages come first. The game checks your position against the
last stage, not the start the map shows, within 150 m plus your phone's accuracy. A find sent by radio follows
the same rule, so unlock the stages in the app first.

## How it is logged and verified

Log it like any cache: **✓ Log a find**, **Couldn't find it** or **Add a note**, in the app or from your radio.
A find can reach **Radio-verified**, **Location-verified** or **Logged**. See
[Traditional caches](traditional.md#how-it-is-logged-and-verified) for the rules, with the last stage in place
of the pin.

Offline, a pack carries the start. An NFC stage with a long enough code also travels in the pack, sealed
under that code: scan or type it, and the stage opens without a connection. Geo, audio and open stages unlock
only online. [Hunting without signal](../offline.md) has the details.

## What a hider sets

Hide the cache as usual and pick **Multi-stage** under **Type**. See
[Traditional caches](traditional.md#what-a-hider-sets) for the fields.

Each stage has:

- an unlock kind: geo, nfc, audio or open;
- a position, revealed when the stage unlocks;
- a clue text, and for an audio stage an audio clip of up to 5 MB;
- a radius, 60 m by default: when the next stage unlocks by location, the finder stands within it;
- a tag code for an NFC stage.

Add the stages after hiding: open the cache, tap **Edit**, and use **Stages** at the end of the form
([Edit your cache](../hide-a-cache.md#edit-your-cache)).

For an NFC stage, use the tag's serial, or nine or more random letters and digits. A shorter code still works
online, but it does not travel in offline packs.

When a hider changes a stage, finders lose the unlocks from that stage on and unlock it again. Unlocks of the
stages before it stay.

## Example

**AC-1234 · Three bridges** · Multi-stage · Difficulty 2.5 · Terrain 2.0.

- **Start** is at the first bridge in JN76. Its clue: "Count the rivets on the sign."
- **The first stage** unlocks by location. OE8APR-7 stands at the first bridge and taps **I'm here — reveal**. The second bridge
  appears.
- **The second stage** unlocks with an NFC tag. A tag under the railing carries a 12-character code. OE8APR-7 scans it, and the third
  bridge appears.

## Tips

- Read every clue before you leave a stage. The next one may need something you can only see there.
- For a geo stage, wait for a good location fix before you tap. A rough fix can put you outside the radius.
- Make an offline pack before you go. NFC stages with long codes then work without coverage.

## Map marker

A pin in blue with a circled M (Ⓜ). The Phosphor theme shows a plain M.

## Next

- [Audio caches](audio.md).
- [Hunting without signal](../offline.md).
