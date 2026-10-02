# Log a find

At the cache, you log what happened: a find, a did-not-find or a note. This page covers logging in the app and
from your radio.

At the cache, tap **✓ Log a find** (or **Log** in the bottom bar). Allow location access when the browser
asks — that reading is what verifies your find. If you refuse, the find is still logged, but not verified by
your phone.

The result shows how well your find is verified:

| Badge                 | Tier | Meaning                                                                                                                                                                             |
| --------------------- | ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Radio-verified**    | A    | Your APRS position was heard on the air near the cache, by a receiving station the instance runs and that isn't yours, on a believable track. Peer instances can also confirm this. |
| **Location-verified** | B    | Your phone's location at logging time matched the cache (within the cache's radius plus your GPS accuracy).                                                                         |
| **Logged**            | C    | Nothing independent placed you at the cache — at most an internet (APRS-IS) position. The find is recorded but not verified.                                                        |

Under the badge, one line says why in plain words — for example how far your phone was from the cache. If a
cache requires a higher tier than your find reached, the find is recorded as **Logged**.

If your phone places you farther from the cache than it can verify, the app asks first: _"You're 34 km from
the cache — log anyway?"_ Each cache takes one find from each callsign, scored when you log it, so logging
it again later shows **You already logged this** and leaves the first find as it was.
Your find is signed with your device key (**signed with your device key ✍**); if you verified your
callsign, it can also be **announced to APRS-IS**.

**No signal?** The app opens without a connection, and a find logged offline is saved, signed with the time
you made it, and verified at that time when it syncs. Before a trip, make an **offline pack** of the area.
[Hunting without signal](offline.md) has it all.

**Couldn't find it** records a [DNF](../glossary.md#dnf); **Add a note** posts a note to the logbook.

## Log from your radio

No phone with you? Send an APRS text message from your radio to the instance's service call — `APRSCG`
unless the instance names another:

| Message                    | Logs                           |
| -------------------------- | ------------------------------ |
| `FOUND AC-1234 nice spot`  | a find, with optional log text |
| `DNF AC-1234 muggles`      | a did-not-find                 |
| `NOTE AC-1234 log is full` | a note                         |
| `HELP`                     | replies with the command list  |

The dash in the code is optional. Your callsign must be verified on your account (**Settings → Account**);
the log goes to the account that holds it.

- **Heard by one of the instance's own receiving stations** (its [attested
  sites](../glossary.md#attested-site)), the message is logged at once.
- **Arrived only over the internet** (APRS-IS, or a relayed MeshCom message), it waits under **You →
  Logs sent over the air** until you tap **Confirm** — anyone can put your callsign on an internet message,
  so the app asks you first. Unconfirmed messages expire after seven days.

The find is verified the usual way, at the time you sent the message: beacon your position near the cache
first, and a find heard by an independent receiving station reaches **[Tier A](../glossary.md#tier)**. A radio
message carries no phone location, so without such a beacon it is recorded at **Tier C**.

Your radio gets an acknowledgement when it numbers the message (radios add a number when they want one), sent
back the way your message came: from the receiving station's own radio when it can transmit (no internet
needed), through the MeshCom node that heard you, or over APRS-IS. A text reply ("AC-1234 found, logged Tier
A") comes only if the operator has turned replies on; `HELP` is always answered. At most ten commands per hour
are accepted from one callsign, all its SSIDs together; more are ignored, without an acknowledgement.

## Your finds are signed

When you log a find, your browser signs it with a key that lives only on your device. You don't have to do
anything; the result shows **signed with your device key ✍**. The signature ties the find to your callsign
even if you later move to another instance.

## Next

- [How finds are verified](verification.md).
- [Community](community.md).
