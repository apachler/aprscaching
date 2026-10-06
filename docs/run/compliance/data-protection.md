# Data protection (GDPR)

This page is for the sysop. It explains what members can export and erase, how long the instance keeps the
rest, and how an erasure reaches the other instances in the network, so you can answer a data-protection
request. The gateway serves `/privacy` from `OPERATOR_NAME`, `OPERATOR_ADDRESS` and `OPERATOR_EMAIL`
([A public instance's duties](index.md#name-the-operator)).

Members run export and erasure themselves ([Your data](../../play/account.md#your-data) is their side). You do
not need to act on a request by hand.

A new account starts with every optional sharing setting off: the email digest, push, the public profile card,
the APRS-IS announce and the near-cache radio message. Only the callsign's game record (finds, hides, badges)
is public from the start. [What a new account shares](../../play/account.md#what-a-new-account-shares) lists
each default.

## Who can act on an account

Sensitive account actions are authorised by the account's own session, or by a signature from a device key
registered to the callsign. There is no central password. A device key is registered only by the signed-in
holder of the call; no machine secret registers one, and neither the sysop nor the operator secret can export
or erase someone else's account.

A suspension never closes a member's access to their own data. A suspended member signs in nowhere, but can ask
for a data link by email (`POST /auth/email/start` with `purpose: "account-data"`). The link opens a session
that reaches export and erasure (`/api/account/me/export`, `/api/account/me/delete`) and nothing else.

## Export

`POST /api/account/<call>/export` returns a full, machine-readable copy of the account's data, whichever held
call names it. It covers every base call the account holds and every SSID of them. The service call is the
instance's, so a sysop's export leaves out its traffic and keys, which carry other people's Mailbox texts.
Secrets such as passkey public keys and push keys stay out of it.

| Field | What it holds |
|---|---|
| `account`, `uiPrefs` | The email address (and one waiting for confirmation), the profile, settings and preferences |
| `callsigns`, `callsignHistory`, `callsignClaims`, `callsignChanges`, `verifications`, `verificationChallenges` | The held calls, their control-verification, claims and holder changes |
| `accountEvents` | What the instance recorded about the calls: a move to another instance, a sysop's verification |
| `caches`, `cacheStages`, `cacheMedia` | Every detail of the caches the person owns, their stages (with each stage's unlock code) and uploaded media |
| `logs`, `ratings`, `favorites`, `watches`, `achievements`, `stageUnlocks` | Finds and notes, ratings, favourites, watched caches, badges, unlocked stages |
| `positions`, `stations`, `stationsOperated`, `rendezvous` | Positions, the person's stations, rendezvous |
| `messages` | The APRS messages the person sent or was sent, with their delivery state |
| `aprsOutbox`, `radioCommands`, `nearCacheMessages`, `boxCommands` | Radio traffic queued from or to the calls, radio commands, near-cache messages, commands sent to the person's boxes |
| `bbsMessages`, `mailbox`, `meshcomGroupMessages`, `whitePages` | BBS mail and bulletins, Mailbox mail, MeshCom group messages, the white-pages entry |
| `weatherKeys`, `weatherReadings` | Weather station keys and the readings stored under the person's calls |
| `keys`, `passkeys`, `apiKeys`, `pushSubscriptions`, `emailTokens` | Device keys, passkeys (no public key), API key prefixes, push endpoints, email links |
| `boxes`, `enrolledBoxes`, `boxEnrollmentCodes` | Boxes the account owns or enrolled, and enrolment codes |
| `watchCalls`, `watchAlerts`, `savedViews`, `entitlements`, `toolRegistries` | Watchlist, its alerts, saved map views, supporter recognition, the tool registries the person added |
| `adoptionRequests`, `adoptionLog` | Adoption requests and the adoption trail rows naming the person |
| `moderationActions`, `suspension`, `reportsFiled` | Moderation records, below |

It also carries what moderation holds about the person: the sysop's actions on their account and content
(`moderationActions`), a suspension in force with its category (`suspension`), and the reports the person
filed (`reportsFiled`).
Reports other people filed about the person stay out, because they would name the reporter.

## Erase

`POST /api/account/<call>/delete` erases the whole account: every base call it holds.

- **Anonymised:** finds, owned caches and the APRS messages the person was sent, from any SSID, pass to a
  withdrawn marker, served as `WITHDRAWN`. The marker can never be registered as a call.
- **Withdrawn:** the text of every APRS message the person sent is deleted. The message keeps its place in the
  log under the marker with an empty body, so the other side's conversation shows a withdrawn message rather
  than a gap. The service call's traffic is the instance's, so a sysop's erasure leaves it.
- **Archived:** owned caches are archived and their uploaded media and stage audio clues removed. A sysop can offer them for
  [adoption](../day-to-day/cache-adoption.md); the adoption trail keeps its rows with the marker in place of the
  person's call, and drops the notes on them.
- **Deleted:** every personal row: passkeys, email links, held calls and their verifications, positions and the
  map's station entry under the call and every SSID of it, device keys, watches, alerts, favourites, saved views, push subscriptions, boxes, ratings, API keys,
  adoption requests, personal BBS mail in both directions, the bulletins and NTS traffic the person posted (replies
  others posted stay), Mailbox mail and the copies the service call sent of it (`de <call>: …`, in the message
  log and the outbox), near-cache radio messages, MeshCom group messages, and the radio messages queued for or
  addressed to the person.
- **Kept, without the reporter:** the reports the person filed stay with the sysop, with the reporter's account
  and call removed.
- **Kept while it holds:** a suspension in force leaves one record per base callsign the account held: the
  callsign, the category and the end date, with no account and no reason text
  ([Moderation records](#moderation-records)). A callsign that already carries a longer suspension keeps it.
- **Kept as a record:** the audit log rows about the person's account and content
  ([Moderation records](#moderation-records)).
- **Cleared:** the call and its SSIDs as the IGate of other people's finds, positions, stations and radio commands
  (the IGate ranking and profile counts follow), as the receiver of MeshCom rows, and as the member who added an
  instance-wide tool registry.
- **Deleted from what the instance heard:** the raw-packet ring rows from the call or naming it in their digipeater
  path, weather readings, MeshCom nodes and links, and NET/ROM MHeard rows. Other members' watchlist entries and
  watch alerts naming the call go too.
- **Untouched:** the service call's keys, stations and traffic, which are the instance's.
- **Freed:** the base calls, for a new registration.
- **Propagated:** a PII-free tombstone tells federation peers to purge their mirrored finds, keys, moves and
  bulletins ([Erasure across the network](#erasure-across-the-network)). A bulletin of the person's that the
  instance mirrored from a peer is suppressed here, so a later sync does not bring it back.

The erasure is one database transaction: the rewrites, the deletions and the tombstones commit together or not at
all. An erasure that fails changes nothing, so the member can ask again. Uploaded media objects leave the object
store right after; one the store refuses stays queued, and the nightly job deletes it.
A sysop's removal of content works the same way: the removal and its tombstone commit together.

## Move to another instance

`/api/account/<call>/bundle`, `/api/account/<call>/move` and `POST /api/account/import` let a member move a
callsign to another instance. Finds are signed on the member's device, so history stays attributable, and a
signed account-move record points attribution at the new instance across the network.

## What the instance keeps, and for how long

| Data | Kept | Setting |
|---|---|---|
| Positions from APRS-IS and from browser radio forwarding | 7 days, pruned nightly; finds use them as evidence | fixed |
| Other positions, finds, caches, accounts, keys | until erased | — |
| Shack raw-packet ring | 24 hours | `RETENTION` (`packetsHours`) |
| Message log and MeshCom group messages | 7 days | `RETENTION` (`messagesDays`) |
| Weather and telemetry readings | 30 days | `RETENTION` (`sensorDays`) |
| Per-port RX/TX counters | 7 days | `RETENTION` (`portStatsDays`) |
| Watch alerts the member has seen | 30 days | `RETENTION` (`alertsDays`) |
| NET/ROM MHeard rows | 7 days | `RETENTION` (`mheardDays`) |
| Delete tombstones | permanently | — |
| Signed records kept to pass on to other instances | as long as the record they carry; a tombstone's permanently | — |
| Federation records no neighbour supplied, listed for the sysop | 90 days unseen, 30 days after marked seen; a missing tombstone is never given up | fixed |
| Media objects queued for deletion | until the object store deletes them, retried nightly | — |
| Open moderation reports | until the sysop resolves them | — |
| Resolved reports and the audit log | 730 days, pruned nightly; the log rows of a suspension in force stay while it holds, also on an erased account's callsigns | `MODERATION_RETENTION_DAYS` |
| Callsign claims and the holder-change trail | 1 year after the claim ends or the change | fixed |
| Email sign-in and confirmation links | 1 day after use, else 2 days after they were sent | fixed |
| A suspension's record on an erased account's callsigns | until the suspension ends or the sysop lifts it | — |
| A member's own tool registries, and the copies of their files the instance fetched for them | until the member removes them or is erased; a copy is refreshed hourly while in use | `TOOL_REGISTRIES_PLAYERS`, `TOOL_REGISTRIES_PROXY` |

`RETENTION` is JSON naming only what you change, for example `{"packetsHours":6,"sensorDays":90}`
([Configuration](../../reference/configuration.md)). What the instance keeps beyond accounts is public ham
identifiers and APRS positions, which are public by design on RF and APRS-IS.

The licence registry (`licence_registry`) holds public-register facts about callsigns: callsign, status, expiry,
source and import date, never a name or address. It is outside export and erasure. Each import replaces a
register's rows and deletes calls the register no longer lists ([Licence registers](../day-to-day/licence-registers.md)).

Once a day the instance asks GitHub for the newest release (`UPDATE_CHECK`). The request names the instance and
carries no member data. While the check is on, the privacy page lists GitHub among the recipients
([How you hear about a new release](../day-to-day/updates.md#how-you-hear-about-a-new-release)).

## Moderation records

Reports, the audit log and suspensions ([Moderation](../day-to-day/moderation.md)) are kept on the instance under
the operator's legitimate interest in answering abuse and showing what was done and why (GDPR Art. 6(1)(f)).
They never federate.

- **A report** holds the item reported, the category, the reporter's words, and the reporter's account and
  call (none for a signed-out visitor). Only the sysop reads it; the reported person never learns who filed it.
- **The audit log** holds who acted, when, the action, the target and the reason. Its rows stay after the
  person concerned erases their account.
- **Retention:** the nightly job deletes a resolved report and an audit log row after `MODERATION_RETENTION_DAYS`
  (730 by default). An open report stays until you resolve it, and the log rows of a suspension in force stay
  while it holds, since they record why. That holds also after the account is erased, as long as the suspension
  lasts on its callsigns.
- **A suspension** holds the account, the reason, the category and the end. When the account is erased while
  it is suspended, only the callsign, the category and the end date stay, so the person cannot come back under
  the same callsign before the suspension ends. That record is deleted at the end date, or when the sysop lifts
  it; an open-ended suspension keeps it until it is lifted.
- **A report email** goes to `OPERATOR_EMAIL` through the configured email provider, with the item, the
  category, the reporter's words and the reporter's call.
- **A removal or suspension notice** goes to the person concerned as an in-app alert, by push where configured,
  and by email when the account has a confirmed address.

## Erasure across the network

Federation peers mirror caches and finds, so an erasure must reach them too. A deletion travels as a **signed,
PII-free tombstone** that names only a global record id, never a callsign. A peer checks the origin's signature,
purges the mirrored rows and refuses to mirror them again.

Tombstones are kept permanently on both sides. They hold only ids, and a mirror checks them on every update, so
deleted data never comes back through a cursor reset, a new hub or a replayed feed. The one bounded tombstone is
the sysop's removal of a cache: it covers the cache up to that removal, so a cache the sysop restores reaches the
peers again, while every copy from before the removal stays suppressed
([Moderation](../day-to-day/moderation.md#what-the-peers-see)).

A tombstone this instance knows it lacks (a gap in an origin's sequence) is never given up: the instance keeps
asking its neighbours, once a day each, until one supplies it. The signed records it keeps to pass on go when the
record they carry is deleted or tombstoned, so a find's logger call does not outlive the find.
[How federation stays honest](../../reference/federation-trust.md) covers the signed feeds that carry them.

## Next

- [A public instance's duties](index.md): the source link and backups a public instance owes.
- [Join the network](../federation/index.md): the peers your tombstones reach.
