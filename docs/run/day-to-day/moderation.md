# Moderation

This page is for the sysop of a public instance. It shows how to answer a report, take content down and
suspend an account. At the end you know what each action does here, on the peers, and for the person concerned.

## Before you start

- You are signed in as a sysop ([Instance admin at a glance](index.md)).
- `OPERATOR_EMAIL` is set, and mail is configured if you want each report by email
  ([Configuration](../../reference/configuration.md)).

## Where moderation lives

**Instance admin** has three moderation groups:

| Group | What you do there |
|---|---|
| **Reports** | the queue of open reports, each with a link to the item and the actions on it; resolved reports on a second tab |
| **Accounts** | find an account by callsign or email, see its content, suspend or lift a suspension |
| **Audit log** | every moderation action, newest first |

Where you already see content, a **More** (**⋯**) menu offers the same actions: on a cache page, on each
logbook row and on each photo or sound in the gallery. Players see **Report** there; you also see **Remove**.

Every route behind these controls checks the sysop server-side. Hiding a control in the app is never the gate.

## Answer a report

Players report a cache, a log, a photo or sound, a message or a profile, with a category (**Spam**,
**Offensive**, **Wrong location or unsafe**, **Copyright** or **Other**) and their own words. A signed-out
visitor can report too, at a lower rate. Each report also goes by email to `OPERATOR_EMAIL` when mail is
configured.

1. Open **Instance admin → Reports**. Each row shows the item, the category, the reporter's words and the
   reporter's callsign.
2. Open the item from its link to see it in place.
3. Choose one:
    - **Remove…** takes the item down and settles every open report on it. A profile report whose call has
      since moved to another account is refused: resolve it instead.
    - **Resolve** closes the report without action, with an optional note.

A resolved report can be reopened from the **Resolved** tab. The reported person never sees a report or learns
who filed it.

## Remove content

**Remove…** asks for a reason of 3 to 500 characters. The reason goes into the audit log and to the person
concerned.

| Item | What removal does |
|---|---|
| Cache | Archived and hidden from everyone but its owner and you; its page, logbook, gallery and stages answer *removed by the instance operator*, and its photos and sounds open for the two of you only. It leaves the map, search, offline packs, nearby prompts, living-cache rendezvous, the leaderboards and the feeds, and its finds stop counting for points and ranks. It takes no log or stage unlock: a player, in the app or over the radio, gets the answer for a code that names no cache. Its adoption offer is withdrawn and open requests on it lapse. The owner cannot edit it, its stages or its media. Finds and the adoption trail keep the row. |
| Log | Deleted (a find, a did-not-find or a note) |
| Photo or sound | Deleted, with its stored file and thumbnail |
| APRS message, BBS message or bulletin, Mailbox message, MeshCom group message | Deleted from this instance |
| Profile | The display name, bio, avatar, links and public contact are cleared; the account stays |

**Restore** brings a removed cache back as *disabled*, so its owner checks it and enables it again. The other
removals are final.

### What the peers see

A removal of a cache, a log or one of this instance's own bulletins emits a signed tombstone. Peers that mirror
the record drop it and never mirror it again
([Erasure across the network](../compliance/data-protection.md#erasure-across-the-network)). A cache's tombstone
covers the cache as it stood when you removed it: a restore changes the cache, so peers mirror the restored
cache again, disabled like here.

A bulletin mirrored from a peer is removed here and blocked against that peer's id, so the next sync does not
bring it back. The peer keeps its own copy; ask its operator, or block the peer under **Federation**.

A bulletin already forwarded to FBB partners cannot be recalled: FBB has no delete, so the partners keep their
copy. Ask their sysops to remove it.

## Suspend an account

1. Open **Instance admin → Accounts**, pick **Look up** and search by callsign or email. **Suspended** lists
   the accounts suspended now, and the callsigns of suspended accounts that were erased.
2. Open the account. It shows its callsigns, its email, open reports about it, its latest content of every kind
   with **Remove…** on each, and the actions taken so far.
3. Select **Suspend…**, give a reason, pick how long (a number of days, or until you lift it) and pick a
   category: **Spam**, **Offensive**, **Wrong location or unsafe**, **Copyright** or **Other**.

While a suspension holds:

- every session of the account ends at once;
- sign-in by passkey, email link or operator link is refused with the reason and the end date;
- the account writes nothing: no log, no hide, no message, and no radio command in its callsigns' name;
- the ingest box cannot post a BBS message in its name, and its Mailbox messages are refused;
- its weather stations' pushes are refused, so they store no reading and send no weather beacon;
- nothing is transmitted for it through this instance: what it had queued for APRS-IS is deleted, and the
  Mailbox messages it left that were still waiting are deleted, not held for a lift.

The account's public content stays. Remove items one by one where needed.

**Lift suspension** ends it early, with a reason. A dated suspension ends by itself at its end date.

An account that holds a callsign in `ADMIN_CALLSIGNS` cannot be suspended here.

A suspended person can still export or erase their data with a request signed by their device key
([Data protection](../compliance/data-protection.md)).

### A suspension outlives an erasure

Erasure removes the account and everything tied to it. A suspension in force leaves one record on each base
callsign the account held: the callsign, the category and the end date. It holds no account, no reason text
and no other data. While it holds:

- nobody registers the callsign, by passkey or email link;
- no account adds it, switches to it or claims it;
- each attempt is refused with *this callsign is suspended on this instance*, the end date and the category;
- the ingest box posts nothing in the callsign's name, a weather push for it is refused, and nothing is sent
  for it.

The record goes when the suspension ends: at its end date (the nightly job deletes it), or when you lift it.
The callsign shows under **Accounts → Suspended** as *account erased*, with **Lift suspension**.

## What the person is told

Each removal, suspension, lifted suspension and restore reaches the person concerned:

- as an alert in their alert list, and by push where configured;
- by email when their account has a confirmed address. That alert then stays out of the digest.

The alert names the item in the owner's words and gives your reason, for example *Your find log on AC-0005 was
removed: not at the cache*. The alert list labels it **Removed by the sysop**, **Restored by the sysop**,
**Account suspended** or **Suspension lifted**.

A suspended person cannot sign in to read the alert. The app they were signed in to says *Your account is
suspended*, with the end date and your reason, and a sign-in link they open shows the same. The email carries
it too.

## The audit log

**Instance admin → Audit log** lists every action: who, when, the action (`remove`, `restore`, `suspend`,
`unsuspend`, `resolve`, `reopen`), the target and the reason. A change to an
[instance setting](instance-settings.md) shows too, with its old and new value, and so does each federation trust
decision: adding, following and removing a peer (`add-peer`, `follow`, `remove-peer`) and moving it between trust
levels (`trust`, `unvet`, `block`, `unblock`), with the levels before and after. It is kept on this instance
and never federates.
A person's export carries the rows about their account; the rows stay after their erasure
([Moderation records](../compliance/data-protection.md#moderation-records)).

## Moderate from a script

The moderation routes take `x-operator-secret` as well as a sysop session. A scripted action shows `OPERATOR`
as its actor in the audit log. The routes and their bodies are in the
[HTTP API](../../reference/api.md#admin-sysop).

## Check that it worked

- A removed cache answers *removed by the instance operator* in a signed-out browser.
- The action shows at the top of **Instance admin → Audit log**.
- A suspended member's next request shows them signed out, and sign-in names the suspension.

## Next

- [Data protection](../compliance/data-protection.md): what the moderation records hold and how long.
- [A public instance's duties](../compliance/index.md): the contacts a public instance publishes.
