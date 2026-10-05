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

## Export

`POST /api/account/<call>/export` returns a full, machine-readable copy of the account's data, whichever held
call names it. It covers every base call the account holds and every SSID of them: the email address (and one
waiting for confirmation), the profile and preferences, caches, finds, positions, the APRS messages the person
sent or was sent with their delivery state, keys, stations, mail and the rest of the account-scoped rows.
Secrets such as passkey public keys and push keys stay out of it.

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
  ([Moderation records](#moderation-records)).
- **Kept as a record:** the audit log rows about the person's account and content
  ([Moderation records](#moderation-records)).
- **Kept:** the Shack raw-packet ring and NET/ROM MHeard rows, which record what the instance heard on the air;
  they age out on their retention below.
- **Freed:** the base calls, for a new registration.
- **Propagated:** a PII-free tombstone tells federation peers to purge their mirrored copies
  ([Erasure across the network](#erasure-across-the-network)).

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
| Open moderation reports | until the sysop resolves them | — |
| Resolved reports and the audit log | 730 days, pruned nightly; the log rows of a suspension in force stay while it holds | `MODERATION_RETENTION_DAYS` |
| Callsign claims and the holder-change trail | 1 year after the claim ends or the change | fixed |
| Email sign-in and confirmation links | 1 day after use, else 2 days after they were sent | fixed |
| A suspension's record on an erased account's callsigns | until the suspension ends or the sysop lifts it | — |

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
  while it holds, since they record why.
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
[How federation stays honest](../../reference/federation-trust.md) covers the signed feeds that carry them.

## Next

- [A public instance's duties](index.md): the source link and backups a public instance owes.
- [Join the network](../federation/index.md): the peers your tombstones reach.
