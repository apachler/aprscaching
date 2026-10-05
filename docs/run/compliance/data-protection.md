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
sent or was sent, keys, stations, mail and the rest of the account-scoped rows. Secrets such as passkey public
keys and push keys stay out of it.

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
  others posted stay), Mailbox mail, near-cache radio messages, MeshCom group messages, and the radio messages
  queued for or addressed to the person.
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

`RETENTION` is JSON naming only what you change, for example `{"packetsHours":6,"sensorDays":90}`
([Configuration](../../reference/configuration.md)). What the instance keeps beyond accounts is public ham
identifiers and APRS positions, which are public by design on RF and APRS-IS.

The licence registry (`licence_registry`) holds public-register facts about callsigns: callsign, status, expiry,
source and import date, never a name or address. It is outside export and erasure. Each import replaces a
register's rows and deletes calls the register no longer lists ([Licence registers](../day-to-day/licence-registers.md)).

## Erasure across the network

Federation peers mirror caches and finds, so an erasure must reach them too. A deletion travels as a **signed,
PII-free tombstone** that names only a global record id, never a callsign. A peer checks the origin's signature,
purges the mirrored rows and refuses to mirror them again.

Tombstones are kept permanently on both sides. They hold only ids, and a mirror checks them on every update, so
deleted data never comes back through a cursor reset, a new hub or a replayed feed.
[How federation stays honest](../../reference/federation-trust.md) covers the signed feeds that carry them.

## Next

- [A public instance's duties](index.md): the source link and backups a public instance owes.
- [Join the network](../federation/index.md): the peers your tombstones reach.
