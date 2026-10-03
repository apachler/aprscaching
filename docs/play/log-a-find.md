# Log a find

This page shows you how to log what happened at a cache: a find, a did-not-find or a note. It is for any
player, in the app or with a radio; at the end your log is in the cache's logbook.

## Before you start

- You are signed in ([Join](join.md)).
- For logging by radio: a [verified callsign](join.md#verify-your-callsign) and an APRS radio or a
  [MeshCom](../glossary.md#meshcom) node.

## Log in the app

1. At the cache, open its sheet and tap **✓ Log a find**. On a phone you can also tap **Log** in the bottom
   bar. The button shows **Locating…** while the phone gets a fix.
2. Tap **Allow** when the browser asks for your location. That reading is what verifies your find. Without
   it, tap **Log without location**; the find is still logged, but not verified by your phone.
3. If the phone places you too far from the cache, the app asks first: *You're 34 km from the cache — log
   anyway?* Tap **Log anyway** or **Not yet**.

The result card opens with **Logged**, a badge, and one line that says why. **✓** next to **Logged** means the
find counts as verified.

### Other log types

| You tap                                           | It logs                                                  | The card shows   |
| ------------------------------------------------- | -------------------------------------------------------- | ---------------- |
| **Couldn't find it**                              | a did-not-find ([DNF](../glossary.md#dnf))               | **Marked DNF**   |
| **Add a note**, then **Post note**                | a note in the logbook                                    | **Note posted**  |
| **Add a note**, then **Post as maintenance**      | what you checked or fixed, for the cache's owner only    | **Note posted**  |

After a find, **Add a note** on the result card adds a note to the same cache.

## Read the result

| Badge                 | What placed you at the cache                                                          |
| --------------------- | ------------------------------------------------------------------------------------- |
| **Radio-verified**    | A receiving station that is not yours heard your APRS position on the air near the cache. |
| **Location-verified** | Your device's location, read when you logged, was at the cache.                         |
| **Logged**            | Nothing independent. The find is on record but not verified.                            |

[How finds are verified](verification.md) explains each badge, with the distances and times.

The line under the badge says why, for example *Your device was 12 m from the cache when you logged it*. Some
caches need a better badge than yours. The line then says so: *This cache needs a Radio-verified find. Yours
was Location-verified, so it is on record but does not count as verified.*

**signed with your device key** means your browser signed the find with a key that stays on your device. You
do nothing for it. The signature ties the find to your callsign, even if you move to another instance.

### One find per person

Each cache takes one find from each person: your base callsign, any SSID of it such as `OE8APR-7`, and any
other callsign on your account share it. The find is scored when you log it. Logging it again with the same
callsign shows **You already logged this**, and your first find stays as it was scored. A find under an SSID
counts for you on the leaderboard, your profile and your badges.

### Caches that take no find

- An **archived** or **disabled** cache takes no find and no **Couldn't find it**. You can still post a note.
- You don't log your **own** cache as found. As its owner you post notes and maintenance logs.

The app shows why in place of **✓ Log a find**. The same rules hold for a log from your radio, and for a log
waiting offline: if the cache was archived meanwhile, the queued log lands under **Needs attention**.

## Log without signal

With no mobile data, a log is saved on your phone. The card shows **Saved** and *offline — will sync when
you're back online*. The top bar counts what waits; tap it to open **Logs to sync**.

When the signal returns, the app sends the log. Your find is verified for the time you made it, not the time
it synced. If the instance refuses a log, it moves to **Needs attention** with the reason. There you retry
it, edit it or discard it. [Hunt without signal](offline.md) has the details.

## Log from your radio

No phone with you? Send an APRS text message from your radio to the instance's service call. The call is
your sysop's callsign with SSID 15, such as `OE8APR-15`; **You** → **Logs sent over the air** names the one
your instance uses.

| Message                    | Logs                                  |
| -------------------------- | ------------------------------------- |
| `FOUND AC-1234 nice spot`  | a find, with optional log text        |
| `DNF AC-1234 muggles`      | a did-not-find, with optional log text |
| `NOTE AC-1234 log is full` | a note; the text is required          |
| `HELP`                     | a reply with the command list         |

`NEAR ON` and `NEAR OFF` switch the message your radio gets near a cache: see
[The "you're near" prompt](find-a-cache.md#the-youre-near-prompt).

The dash in a cache code is optional. A heritage place takes its reference as the code, for example
`FOUND OE/ST-001`. A MeshCom direct message to the service call works the same way.

The log goes to the account that holds your callsign, with any SSID. Your callsign must be verified first;
otherwise the message is not logged, and **You** → **Logs sent over the air** lists it as **not logged** with the
reason. A message the instance could not read shows there the same way.

### Where it lands

- **Heard on the air by one of the instance's own receiving stations**: the log is written at once.
- **Sent from the app's own radio bridge** (**Settings** → **My radio (browser)**): written at once too, since
  your device signs it.
- **Arrived only over the internet** (APRS-IS, or a relayed MeshCom message): it waits under **You** →
  **Logs sent over the air**, marked **to confirm**. Tap **Confirm** to log it, or **Discard**. Anyone can put
  your callsign on an internet message, so the app asks you first. A message you do not confirm within 7 days
  expires.

### How radio finds are verified

The find is scored for the time you sent the message. A radio message carries no phone location, so it gets
one of two badges:

- **Radio-verified** when a receiving station that is not yours heard your position beacon near the cache in
  the 30 minutes before the message. Beacon at the cache first, then send `FOUND`.
- **Logged** otherwise.

### Acknowledgements and limits

- Your radio gets an acknowledgement when it numbers the message. Most radios number messages that want one.
- A text reply, such as *AC-1234 found, logged Tier A*, comes only if your sysop turns replies on. `HELP` is
  answered either way. You get at most one reply every 10 minutes.
- A retry of the same message within 30 minutes is only acknowledged again, never logged twice.
- One callsign may send ten commands an hour, all its SSIDs together. More are ignored, with no
  acknowledgement.

## Announce your finds on APRS-IS

With a verified callsign, each verified find can be announced to [APRS-IS](../glossary.md#aprs-is) as a short
status message from your callsign, for example *Found AC-1234 (Rover on the ridge) via aprscaching.net*.
Announcing is off unless you opt in: turn on **Settings** → **Announce finds**. The result card then shows
**announced to APRS-IS**. The switch covers finds logged in the app and by radio, from any SSID of your call.

## Check that it worked

- Open the cache sheet and scroll to the **Logbook**. Your log is at the top, with its badge.
- For a radio log, **You** → **Logs sent over the air** shows **logged**.
- For an offline log, **Logs to sync** is empty once it has synced.

## Next

- [How finds are verified](verification.md): how to earn a better badge.
- [Community](community.md): ratings, badges and ranks.
