# Instance admin at a glance

This page is for the sysop who keeps an instance running. It lists what only the sysop sees in the app, and
links each recurring task: checks, backups, updates, sign-in links and the rest.

## Who sees the admin surface

The **Admin** entry in the navigation rail opens **Instance admin**. It appears only for a sysop: a signed-in
account whose active callsign is in `ADMIN_CALLSIGNS` and is control-verified
([Who is a sysop](../../reference/secrets.md#who-is-a-sysop)). The server checks every admin write itself, so
hiding a control in the app is never the only gate. When `ADMIN_CALLSIGNS` is unset, nobody sees the surface.

Instance admin holds settings for the **whole instance**. A member's own settings (account, callsigns,
preferences, media, tools, their own data) stay under **Settings** and are not part of it.

## Operator-only surfaces

**Instance admin** has these groups, each collapsed until you open it:

| Group | What you do there | Page |
|---|---|---|
| **Setup** | the first-install checklist: *Blocking*, *Recommended* and *Optional* items, and the 44Net self-check | [Your first hour](../first-hour.md) |
| **Callsign verification** | verify a call by hand, list and revoke manual verifications | [Callsign verification](callsign-verification.md) |
| **Stations for members** | list a club station for the member who runs it, when that member does not hold the club call: give the member's callsign, the station's callsign and its position (blank takes a heard station's) | [Stations for members](#stations-for-members) |
| **Cache adoption** | offer caches for adoption, decide requests, assign an owner | [Cache adoption](cache-adoption.md) |
| **Federation** | the peer list with health and reputation, each peer's trust (`trusted`, `unvetted`, `blocked`), a manual sync | [Join the network](../federation/index.md) |
| **Forwarding** | FBB partner BBSes (callsign, protocol, intervals, time bands, message types), routing rules, and the White Pages directory that steers personal mail | [Packet: BBS and NET/ROM node](../radios/packet-node.md) |
| **Trusted receiving stations** | trust a receiving station's own on-air hearings for Radio-verified finds and on-air callsign verification: **Trust station** by site call, remove one; `FIRST_PARTY_SITES` calls show read-only | [RF ingest and transports](../radios/rf-ingest.md) |
| **Ingest boxes** | enroll a box, revoke one, and **Trust this station's hearings** for a lent receiver | [Set up an ingest box](../radios/ingest-box.md), [Lend a receiver](../radios/lend-a-receiver.md) |
| **Ingest & transports** | the data plane: the transports and the TAK/CoT feed | [RF ingest and transports](../radios/rf-ingest.md) |

The TAK/CoT feed, `GET /api/cot?bbox=`, serves the live station list as Cursor-on-Target for ATAK, WinTAK and
iTAK.

## Stations for members

A member lists under **Settings → My stations** only stations of the callsigns their account holds and has
verified: `OE8APR-9` needs `OE8APR`, verified, on their account. That keeps anyone from listing another
operator's station and hiding a living cache that follows it. A club station whose call the member does not hold
is listed for them under **Instance admin → Stations for members**; it then shows under their **My stations**, and
they manage it like their own. When the club call itself is on an account, as a second callsign verified there,
that account lists the club's stations directly.

## Recurring tasks

| Task | Page |
|---|---|
| Check the installation, set up a shape, rotate a secret | [The deploy/aprscaching command](helper-command.md) |
| Find what a doctor result means and fix it | [Troubleshooting](../troubleshooting.md) |
| Back up, restore, move to another shape | [Backups and moving](backups.md) |
| Bring the instance to a new release | [Updates](updates.md) |
| Sign someone in without a passkey | [One-time sign-in links](sign-in-links.md) |
| Send sign-in links and the digest by mail, or test that mail | [Send mail](mail.md) |
| Verify a member's callsign by hand | [Callsign verification](callsign-verification.md) |
| Give an abandoned cache a new owner | [Cache adoption](cache-adoption.md) |
| Keep the register badge current | [Licence registers](licence-registers.md) |
| Import summits, parks and castles as caches | [Import heritage places](import-places.md) |

## Next

- [The deploy/aprscaching command](helper-command.md): the one command behind most of these tasks.
- [Backups and moving](backups.md): what to back up, and how.
