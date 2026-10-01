# Administration

Some configuration governs the **whole instance** and belongs to the ham who deployed it — not to platform
users. This surface is separate from per-user settings and is gated server-side.

## Operator identity

`ADMIN_CALLSIGNS` (comma-separated licensed calls) names the instance operator(s). A signed-in account is a
**sysop** when its active callsign is in that list, the account holds that call, and the call is
**control-verified** — the same proof transmit needs. Signing up under a listed call grants nothing until
that verification succeeds, so the operator confirms their call once after first sign-in, with the operator
CLI:

```bash
docker compose exec gateway node tools/admin/verify-call.mjs OE8APR                   # Docker stack, from deploy/
BASE=https://api.example.net OPERATOR_SECRET=… node tools/admin/verify-call.mjs OE8APR   # from a checkout
```

It calls `POST /verify/operator` with the operator secret (`x-operator-secret`), which verifies a call listed in `ADMIN_CALLSIGNS`
(method `operator`) and nothing else. `GET /api/admin/whoami` tells the web app whether to reveal the operator
surface; for the account that holds a listed call not yet confirmed it answers `pending: "verify"`, and
**Settings → Account** shows that operator both commands. Nobody else learns anything about the list. Every operator write is enforced by `requireSysop` on the server — hiding a control in
the UI is never the gate. If `ADMIN_CALLSIGNS` is unset, the web operator surface is locked entirely.

## Machine credentials

Two shared secrets reach the gateway from machines, and they never overlap:

| Secret | Header | Authorises | Held by |
|---|---|---|---|
| `INGEST_SECRET` | `x-ingest-secret` | The ingest plane: `/ingest`, the outbox, BBS delivery and the FBB forwarding pool, reading the forwarding partner list, the NET/ROM node mirror, heard federation beacons and sync pages, the catalog importer, finds logged over APRS, remote-box polling and pairing | the ingest box |
| `OPERATOR_SECRET` | `x-operator-secret` | Instance-wide configuration from scripts: reading the Setup checklist (`GET /api/admin/setup`, which `deploy/aprscaching doctor` relays), `POST /verify/operator`, the one-time sign-in link (`POST /auth/operator-link`), `POST /federation/sync`, the peer list and trust, 44net onboarding, forwarding partners and rules, the FBB federation enqueue, relay dispatch, donation confirms, licence-register imports | the operator |

The ingest secret never registers a device key, never verifies a callsign and never signs a session, so a
stolen ingest box cannot take over an account or the instance. The operator secret mints one-time sign-in
links ([Off-grid sign-in](first-hour.md#off-grid-sign-in)): on an instance with passkeys or email only for
`ADMIN_CALLSIGNS` calls, on an off-grid instance for any account — keep it on the gateway host. Leave `OPERATOR_SECRET` unset to close the
machine paths altogether; the web operator surface is unaffected. Sessions are signed with the separate
`SESSION_SECRET`.

## Sessions

A session names the account behind it and that account's session generation, and is honoured only while
the account exists at that generation and still holds the session's call. Erasing an account, changing the
active callsign, and **Settings → Account → Sign out everywhere** (`POST /auth/logout-all`) each end every
outstanding session of that account; an erased account's cookie never acts as the next holder of the same
call. To sign out every user at once, set `SESSION_EPOCH` to the current Unix time or rotate
`SESSION_SECRET`. Revoking a manual callsign verification does not end sessions — the account still holds
the call, and transmitting and the sysop role check verification on every request.

!!! warning
    `ADMIN_CALLSIGNS` is security-critical and env-only — it must never be settable at runtime. It works
    identically on every runtime (Worker, Node, Bun): the self-host servers forward the complete config-key
    set into the gateway, so every deployment shape has the web sysop surface when the variable is set.

## Callsign verification

Users verify their own calls under **Settings → Account → verify**, choosing a method. Every verification
records its method (`callsign_verifications.method`) and who vouched (`verified_by`):

| Method | How | `verified_by` | Needs on this instance |
|---|---|---|---|
| `rf_heard` | `VERIFY <code>` sent to the service call, heard by a site in `FIRST_PARTY_SITES` on its own TNC, or by its MeshCom node directly over LoRa | the receiving site | attested sites |
| `ampr_dns` | a code in `_aprscaching.<call>.ampr.org` TXT: a DNSSEC-validated answer over `DOH_URL`, or else the same TXT set from every resolver of `AMPR_DNS_RESOLVERS` that answers (at least 2) | `<call>.ampr.org` | outbound HTTPS to the resolvers |
| `lotw` | a challenge signed with the user's LoTW callsign certificate, which must chain to a CA in `LOTW_CA_PEM` and name the call | the trusted CA's name | `LOTW_CA_PEM` |
| `operator` | the operator CLI with the operator secret, for an `ADMIN_CALLSIGNS` call | `operator` | — |
| `sysop` | by hand, below | the sysop's call | — |

On the air, a copy over APRS-IS, AXUDP/AXIP, the MeshCom server, a mesh relay or a signed browser batch
never counts. Without attested sites nobody can verify that way.

`callsign_verifications` is the one record of a verification: the session, the held-call list, device
keys, transmitting and the sysop role all read it, so a revocation takes effect everywhere at once. A
verification covers the base call and every SSID of it. Claiming a call nobody held starts it unverified —
whatever was recorded for it before was for someone else — so verify a call (including your own operator
call with the CLI) after its holder has signed up.

The `ampr_dns` method accepts one of two proofs, and stores which one held in the verification's `note`:

| Proof | `note` | Strength |
|---|---|---|
| DNSSEC | `dnssec` | `DOH_URL` validated the answer from the root (AD flag). Cryptographic: forging it means breaking the zone's signatures. |
| Independent resolvers | `<n> resolvers: <hosts>` | Without AD, every resolver of `AMPR_DNS_RESOLVERS` (default Cloudflare, Google, Quad9) is asked; at least 2 must answer, and every one that answers must return NOERROR with the same TXT set carrying the code. Forging it means poisoning several large, separately run resolver caches at the same moment, or the path from them to ARDC's name servers. |

A resolver that times out or fails at the HTTP level has not answered and does not block the others; a DNS
error or a different TXT set from any resolver refuses. An answer through a CNAME or DNAME is refused
either way, so a proof never leaves the ampr.org zone. A name that does not exist yet costs the user no
attempt: the ARDC portal publishes the zone periodically, and users check again until it does.

While ampr.org is not DNSSEC-signed (the `org` zone publishes no DS record for it), verifications use the
resolver proof. Once ARDC signs the zone, `DOH_URL` returns AD and new verifications use DNSSEC without any
change here. `AMPR_REQUIRE_DNSSEC=1` accepts only the DNSSEC proof: while the zone is unsigned every check is
then refused with that reason, and users pick another method. To re-check or revoke the weaker ones later,
list them:

```sql
SELECT callsign, verified_at, note FROM callsign_verifications
 WHERE status = 'verified' AND method = 'ampr_dns' AND note <> 'dnssec';
```

### LoTW callsign certificates

No ARRL certificate ships with the gateway, so the `lotw` method stays off until you set `LOTW_CA_PEM` to the
LoTW CA certificate(s) you trust — normally ARRL's *Logbook of the World Root CA*. Trusting the root is
enough: TQSL writes the whole chain (callsign certificate, production CA, root) into every `.p12` it saves,
and the browser sends that chain along. As a LoTW user you can take the CA certificates from your own file:

```
openssl pkcs12 -in my-call.p12 -cacerts -nokeys -out lotw-ca.pem   # add -legacy for an older-format file
openssl x509 -in lotw-ca.pem -noout -subject -dates -fingerprint -sha256
```

Keep only the root's block, and compare its SHA-256 fingerprint with a second independent copy — another
ham's TQSL file, or ARRL — before you trust it. The gateway then checks each callsign certificate's
signature chain, that it is valid now and each CA was valid when it issued the certificate below it, that
its subject attribute `AROcallsign` (OID `1.3.6.1.4.1.12348.1.1`) is exactly the base call, and the user's
signature over the challenge. It does not consult LoTW's certificate revocation service.

For an operator out of range of every attested site, a sysop verifies the call by hand under **Instance
admin → Callsign verification**: the callsign, and a required note saying how control of the licence was
checked. The call is verified with method `sysop`, recording the sysop's call and the time; the list shows
every manual verification, and **Revoke** returns a call to unverified. Revoking touches only manual
verifications — a call verified on the air or by the operator CLI is neither listed nor revocable there.
Both actions are logged in `account_events`.

## Cache adoption

A cache whose owner erased their account is archived and owned by a withdrawn marker, so nobody can edit it;
a cache whose owner stopped looking after it has the same problem while the owner still exists. **Instance
admin → Cache adoption** hands such caches to new owners.

- **Offer for adoption** — by cache code, or with **Offer…** on a cache under **Withdrawn owners**, with a
  required note saying why. The note is public: the cache appears in the **Up for adoption** list and on its
  own page. Only caches hidden on this instance can be offered; imported caches cannot.
- **An active owner is told and can refuse.** Offering a cache whose owner still has an account puts an alert
  in the owner's list (and a push, where configured) and shows the offer on the cache page, where **Keep my
  cache** ends it. Such a cache cannot change hands until the offer has stood for **14 days**; a withdrawn
  owner has nobody to tell, so there is no wait.
- **Requests, then approval.** A signed-in user whose call is control-verified asks for an offered cache from
  its page, saying whether they have checked that the container is in place. Requests wait for a sysop:
  first come would let the quickest account grab any cache, and a person can check who is asking. **Approve**
  hands the cache over and declines the other requests; **Decline** tells the requester.
- **Assign…** hands a cache straight to a call: the call must be held by an account and control-verified
  (verify it by hand first if needed), and a note is required. Tick **the container is confirmed in place**
  to make the cache active again.
- **Withdraw offer** ends an offer and cancels its pending requests.

A hand-over changes only the owner — and the status, to active, when the container is confirmed in place;
otherwise the cache keeps its status until the new owner edits it. Finds, logs, media and history stay with
the cache. Approval re-checks that the requester's account still holds the call and that it is still
verified. The new owner reaches federation peers through the caches feed, which carries every cache change;
a local-only cache stays local and an unlisted one keeps its description back.

Every step — offer, withdrawal, owner refusal, request, cancellation, approval, decline, assignment — is kept
in `cache_adoptions` with who, when, the owner before and after, and the note; the latest are under **Recent
activity**. A person's export includes their requests and the trail rows naming them; erasure deletes their
requests and replaces their call in the trail with the withdrawn marker, dropping the notes on those rows.

## Licence registers

The licence badge shows whether a public register lists a call as licensed ([Licence
registers](../reference/licence-sources.md)). It needs the registers imported. The import tool runs on the
operator's machine — the ingest box, or any computer with Node 22+ — downloads each register, keeps only
callsign, status and expiry, and posts them to the gateway with `OPERATOR_SECRET`:

```bash
BASE=https://api.example.net OPERATOR_SECRET=… node tools/licence/import.mjs --source fcc,ised,at,de
node tools/licence/import.mjs --list              # the registers it knows
```

The PDF registers (`at`, `de`) need `pdftotext` (`apt install poppler-utils`). The FCC file is about 200 MB and
lists about 1.6 million calls; allow a few minutes for its download and import. Each import replaces that
register's rows, and calls it no longer lists are removed; an import that fails part-way removes nothing.
Until a register is imported, every call reads "not found in public registers" — nothing else changes.

**Keep it fresh on a schedule.** Set `LICENCE_SOURCES` and run the tool from cron or a systemd timer; the
FCC rebuilds its full file weekly and the other registers change more slowly, so a weekly run is enough:

```bash
# /etc/cron.d/aprscaching-licence — Sundays 04:30
30 4 * * 0  aprs  cd /opt/aprscaching && BASE=http://127.0.0.1:8787 OPERATOR_SECRET=… LICENCE_SOURCES=fcc,ised,at,de node tools/licence/import.mjs
```

```ini
# /etc/systemd/system/aprscaching-licence.service   (+ a .timer with OnCalendar=weekly)
[Service]
Type=oneshot
WorkingDirectory=/opt/aprscaching
EnvironmentFile=/opt/aprscaching/deploy/.env
Environment=LICENCE_SOURCES=fcc,ised,at,de
ExecStart=/usr/bin/node tools/licence/import.mjs
```

The registry holds no user data (see [Data protection](#data-protection-gdpr-dsgvo)).

## Operator-only surfaces

Reached from the instance-admin panel (shown only to operators):

- **Callsign verification** — verify a call by hand, list and revoke manual verifications (above).
- **Cache adoption** — offer caches for adoption, decide requests, assign an owner (above).
- **Federation** — the peer list with health and reputation, per-peer **trust** (`trusted` / `unvetted` /
  `blocked`), and a manual sync trigger. See [Federation](../guides/federation.md).
- **FBB forwarding** — partner BBSes (callsign, protocol, intervals, time-bands, message types) and
  hierarchical routing rules, plus the White Pages directory that steers personal mail.
- **NET/ROM node** — the learned NODES routing table.
- **Ingest & transports** — the data plane (transports and the TAK/CoT feed). `GET /api/cot?bbox=` renders
  the live station registry as Cursor-on-Target for ATAK / WinTAK / iTAK.

Everything a normal user does — hiding and logging caches, favorites and ratings, callsign management,
preferences, media, enabling tools, and their own data actions — is **not** on this surface.

## Import heritage places

Places from other programs — summits, parks, castles, islands — can be imported as caches. An import runs
on request, from any machine that knows the instance's `INGEST_SECRET` (the importer is part of the ingest
plane); running it again updates the
places in place. Every place carries its source and a link back, duplicates across sources collapse to
the ham-radio program's entry, and imported places never leave your instance.

```bash
curl -X POST https://your.instance/api/import/sota \
  -H "x-ingest-secret: $INGEST_SECRET" -H "content-type: application/json" \
  -d '{"region":"OE/ST"}'
```

The answer lists how many places were fetched, imported, updated, skipped and de-duplicated.

| Source | Body | Example |
|---|---|---|
| `sota` | `region` = association/region | `{"region":"OE/ST"}` |
| `pota` | `region` = POTA location (all parks when empty) | `{"region":"US-NY"}` |
| `wwff` | `region` = programme | `{"region":"OEFF"}` |
| `iota` | `region` = reference prefix | `{"region":"EU"}` |
| `bunker` (WWBOTA/UKBOTA) | `bbox` = `[minLon,minLat,maxLon,maxLat]` | `{"bbox":[13,46.5,16,48]}` |
| `gcau` (Geocaching Australia) | `region` = state | `{"region":"vic"}` |
| `opencaching` | `bbox`, plus `url` + `key` of the node (or `OKAPI_BASE` + `OKAPI_KEY`) | `{"bbox":[13,46.5,16,48]}` |
| `osm` | `bbox`, `region` = OSM tag (default `natural=peak`) | `{"bbox":[13,46.5,16,48],"region":"historic=castle"}` |
| `wikidata` | `region` = class (default `Q8502` mountain; `Q23413` castle, `Q39715` lighthouse), optional `bbox`, `limit` | `{"region":"Q23413","bbox":[13,46.5,16,48]}` |
| `geojson` | `url` of a GeoJSON file, optional `sourceName`, `type`, `deepLink` | `{"url":"https://example.org/castles.geojson"}` |

Respect each source's licence; OpenCaching content in particular carries conditions (see `TODO.md`).

## Remote control of your box

You can drive your own ingest box from the web app without opening any inbound port: the app enqueues
commands and the box pulls them over its existing outbound connection (`/api/box/:id/*`), runs them, and
reports each result back to the command log in **Shack → Remote box**.

1. On the box, set `BOX_ID` to a name of your choice (for example `pi-home`) and restart the ingest. At start
   the box prints a one-time pairing code to its log:
   `[box] pairing code for pi-home: ABCD-EFGH (valid 15 min)`.
2. In the app, enter the same name as the **Box ID**, then the **Pairing code**, and press **Pair box**. The
   box then belongs to your account; no other account can send it commands or read its log. The code is
   single-use and expires after 15 minutes — restart the box for a fresh one. Pairing again with a new code
   moves the box to whoever enters it, so only someone who can see the box's output can take it over.
3. Press **Status**: within a few seconds the log shows the box's uptime and which functions are on.

Status and switching the digipeater, IGate or transmit **off** work with `BOX_ID` alone. Anything that keys
the radio — a beacon, a message, or switching a function **on** — is gated twice:

- the gateway accepts it only for a **verified callsign** your account holds;
- the box runs it only when you set `BOX_TX=1` on the box, the command's callsign has the same base call
  as the box's station call (`BOX_CALL`, else `IGATE_CALL`, else `DIGI_CALL`), and it was queued within the
  last `BOX_CMD_MAX_AGE` seconds (15 minutes by default). Remote transmits are also rate-limited on the box
  (three in a burst, then one per minute).

**TX off** is the box's master switch: it silences the APRS digipeater, IGate transmit to RF and remote
transmits until switched on again or the ingest restarts. The switches live in memory, so a restart
returns the box to its configured state. See [Configuration](../reference/configuration.md) for every
variable.

With `BOX_TX=1` the box also answers players' radio commands (`FOUND AC-1234` sent to `APRSCG`,
[Log from your radio](../guides/caching.md#log-from-your-radio)) that it heard itself: the ack goes out on
its own radio as third-party traffic from `APRSCG` under `BOX_CALL`, or through its MeshCom node when
`MESHCOM_TX=1`, so a box with a radio acknowledges finds even without internet. These answers pass the same
gates — the transmit switch, the command age and the rate limit.

## Data protection (GDPR / DSGVO)

Sensitive account actions are authorised by the account's own session or a signature from a device key
registered to the callsign — there is no central password. A device key is registered only by the signed-in
holder of the call; no machine secret registers one.

- **Export** (`POST /api/account/:call/export`) returns a full machine-readable copy of the account's data.
- **Erase** (`/delete`) covers the whole account: every base call it holds. It anonymises finds, owned
  caches and messages to a withdrawn marker (served as `WITHDRAWN`; the name can never be registered),
  archives owned caches (a sysop can offer them for [adoption](#cache-adoption)) and removes their
  uploaded media, deletes every personal row — passkeys, email links, held calls, watches, alerts, saved
  views, push subscriptions, boxes, ratings, API keys, adoption requests and personal BBS mail — frees the base calls for a new registration, and emits a **PII-free tombstone** so
  federation peers purge their mirrored copies.
- **Portability** (`/bundle`, `/move`, `/api/account/import`) lets a user migrate a callsign to another
  instance; because finds are device-signed, history stays attributable, and an account-move record
  re-points attribution across the network.

The licence registry (`licence_registry`) holds public-register facts about callsigns — callsign, status,
expiry, source and import date, never a name or address — so it is outside export and erasure. Each import
replaces a register's rows and deletes calls it no longer lists.

Positions are TTL'd; the retained record is public ham identifiers and APRS positions that are public by
design on RF/APRS-IS. Delete tombstones are kept permanently: they carry only PII-free global ids, and
every mirror consults them so deleted data is never re-mirrored.
