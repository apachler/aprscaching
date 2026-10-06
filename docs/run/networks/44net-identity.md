# 44Net name and identity

This page publishes your instance's federation identity under your `<call>.ampr.org` name and checks it. It
is for a licensed sysop whose box already has its 44.x address, or who wants peers to add an internet-only
instance by callsign. At the end peers can add your instance by callsign, and the self-check passes.

It continues [44Net address](44net.md), whose steps 1 and 2 get the address and bring the tunnel up. ARDC
issues `<call>.ampr.org` only after checking the holder's licence, so a record you publish under it ties
your federation key to your verified callsign. Statements about ARDC's services link the ARDC page they come
from, checked on 2026-09-30 ([Sources](44net.md#sources)).

## Before you start

- Your callsign subdomain `<call>.ampr.org` is approved in the 44Net Portal.
- On 44Net: the tunnel is up and `ip addr show wg44` lists your 44.x address ([44Net address](44net.md)).
  Without 44Net, see [Identity without 44Net](#identity-without-44net).
- `ADMIN_CALLSIGNS` names your call, and the instance has a federation key (`FED_PRIVATE_KEY`).

## 3. Name and identity

An instance never runs on the base name `<call>.ampr.org`. It runs at a name under it, by default
`aprscaching.<call>.ampr.org`, and the base name stays free for your other uses. The base name carries only
the lookup record peers read when they add you by callsign.

**Instance admin → Federation → Publish your callsign identity** shows the exact records to copy, computed
from your `INSTANCE`, your federation key, your call, the `44net` endpoint and `APP_URL`, with a copy button
and a hint on each field. Enter them in the Portal under **DNS → My subdomains → Resource Records**
([DNS/Portal/Records](https://wiki.ampr.org/wiki/DNS/Portal/Records)). The Portal takes only the part of each
name left of `<call>.ampr.org`.

The normal recipe is two records:

| Name in the Portal | Type | Value | What it is for |
|---|---|---|---|
| `aprscaching` | A | your 44.x Connect address | The name peers connect to, `aprscaching.<call>.ampr.org` |
| `_aprscaching` | TXT | `v=acs1; inst=<INSTANCE>; key=<federation key>` | Your federation identity: peers add you by callsign |

No NS record, CNAME or delegation is needed, and an AAAA record is not used. Don't put `_aprscaching` behind a
CNAME: the lookup must stay inside the ARDC zone.

The admin page shows the TXT value that matches the instance's own configuration as its main record:

| The instance has | Main TXT value | Under the disclosure |
|---|---|---|
| a `44net` endpoint and a public https `APP_URL` | `v=acs1; inst=…; key=…; host=<44Net name>; web=https://<APP_URL host>` | the 44Net-only value (**44Net only instead?**) |
| a `44net` endpoint only (a LAN, loopback or plain-http `APP_URL`) | `v=acs1; inst=…; key=…` | — |
| a public https `APP_URL` only | `v=acs1; inst=…; key=…; web=https://<APP_URL host>`, and no A record | — |

`net44 setup` and `net44 check` print the same main value.

**Worked example.** OE8APR runs an instance on 44Net whose `APP_URL` is `https://aprs.example.net`:

```
aprscaching.oe8apr.ampr.org   A    44.27.132.9
_aprscaching.oe8apr.ampr.org  TXT  "v=acs1; inst=aprs.example.net; key=<federation key>; host=aprscaching.oe8apr.ampr.org; web=https://aprs.example.net"
```

`inst=` is `aprs.example.net`, the instance's `INSTANCE`. A peer that adds `OE8APR` reads
`_aprscaching.oe8apr.ampr.org`; a peer on 44Net connects to `http://aprscaching.oe8apr.ampr.org`, any other to
`https://aprs.example.net`. Without the https address the record is the plain `v=acs1; inst=…; key=…`, and peers
connect over 44Net only.

**The fields of the TXT record.**

| Field | Required | Meaning |
|---|---|---|
| `inst=` | yes | This instance's `INSTANCE`, exactly; by default `APP_URL`'s host |
| `key=` | yes | The current federation public key (raw Ed25519, base64url); `node tools/fedkey/genkey.mjs` prints it when it creates the key |
| `host=` | no | Another name under your call, `<label>.<call>.ampr.org`, for peers to connect to over 44Net. The base name `<call>.ampr.org` and any name outside your zone make the whole record invalid |
| `web=` | no | An https origin, `https://<host>[:<port>]`, for peers to connect to over the internet. With `web=`, peers connect over 44Net only at a `host=` the record names too |

Without `host=` and `web=`, peers connect over 44Net at the default name. `host=` and `web=` change only where
peers connect; identity, trust and the key pin stay the same. After
[rotating the federation key](../../reference/federation-trust.md#signed-feeds), update `key=`: peers that
already follow you move their pin along your signed rotation record, and a new peer refuses a key your
descriptor no longer lists.

### Several instances under one call

A further instance (a Pocket, a test box, a club's second instance) runs under a label of its own and publishes
its own record at `_aprscaching.<label>`:

```
aprscaching.oe8apr.ampr.org                      A    44.27.132.9
_aprscaching.oe8apr.ampr.org                     TXT  "v=acs1; inst=aprs.example.net; key=<home key>"
aprscaching-pocket.oe8apr.ampr.org               A    44.27.132.10
_aprscaching.aprscaching-pocket.oe8apr.ampr.org  TXT  "v=acs1; inst=oe8apr-pocket; key=<Pocket key>"
```

In the Portal the Pocket's names are `aprscaching-pocket` and `_aprscaching.aprscaching-pocket`; the Portal's name
field accepts the dotted underscore name as it stands (checked on 2026-10-05). Peers add
the home station by callsign and the Pocket by its host, `aprscaching-pocket.oe8apr.ampr.org`, in the same
field under **Instance admin → Federation**. Both are recorded as instances of your callsign, so a peer's
corroboration quorum counts them as one voice. A name that carries two federation records is ambiguous: the
lookup lists them, and the peer's operator adds one by its host.

### Identity without 44Net

An instance that is only on the internet can still be added by callsign. It publishes one TXT record and no A
record:

| Name in the Portal | Type | Value |
|---|---|---|
| `_aprscaching` | TXT | `v=acs1; inst=<INSTANCE>; key=<federation key>; web=https://<your APP_URL host>` |

It needs the approved `<call>.ampr.org` subdomain, not a 44Net Connect address. A peer that adds your callsign
reads the record, fetches `https://<your host>/.well-known/aprscaching`, and accepts you only when that
descriptor names the same instance as `inst=`, lists the DNS key among its active keys, and names your call as
its service call (from `ADMIN_CALLSIGNS` or `SERVICE_CALL`) or its operator (`FED_OPERATOR`). The fetch follows
the same rules as every federation fetch: https only, and no private addresses unless the peer sets
`FED_ALLOW_PRIVATE`. A descriptor that does not answer refuses the addition; the peer tries again later.

An instance on both networks names both places: `v=acs1; inst=…; key=…; host=aprscaching.<call>.ampr.org;
web=https://…`, the main record the admin page shows for it. A peer that is on 44Net itself connects over 44Net
first; any other peer connects over https.

`web=` cannot usefully send peers to a third party. The origin it names must serve a descriptor that lists the
key of the record and names your call. A record with your own key at someone else's origin fails because their
descriptor does not list your key; a record copying their public instance id and key fails because their
descriptor does not name your call.

### How long DNS takes

- The Portal exports DNS changes **hourly**: "Expect up to about one hour for updates to reach the
  authoritative servers, plus any resolver caching based on TTL"
  ([DNS/Portal](https://wiki.ampr.org/wiki/DNS/Portal)). A new name appears within about an hour.
- A lookup that still returns NXDOMAIN after that means the record was not published. Check in the Portal
  that it was saved, that its **Active** box is ticked, and that the subdomain is not still waiting for
  approval.
- A negative answer is cached for about 5 minutes (the zone's SOA), so a retry after publishing is not held
  up for long.
- The default TTL is **1 day** ([DNS/Portal/Records](https://wiki.ampr.org/wiki/DNS/Portal/Records)). A
  changed record can stay cached for up to that long wherever it was already resolved. Before a planned
  change (a new address, a rotated key), set a short TTL on the record (the Portal's TTL field accepts it,
  for example 300 seconds) and wait out the old TTL first.

`ampr.org` is served by `ns.ardc.net`, `ns1.de.ardc.net`, `ns2.us.ardc.net` and `a.gw4.uk` (the last is not
an ardc.net host; listed by a live NS query on 2026-09-30).

### DNSSEC

"Currently, DNSSEC is not enabled for ampr.org. We expect to implement it in the future."
([DNS/Portal](https://wiki.ampr.org/wiki/DNS/Portal)). Until it is, no resolver sets the AD flag for these
records, so:

- adding a peer by callsign falls back to the operator's one-time confirmation (trust-on-first-use);
- `ampr.org` callsign verification falls back to several independent resolvers agreeing
  (`AMPR_DNS_RESOLVERS`, see [Callsign verification](../day-to-day/callsign-verification.md)).

The Portal accepts A records outside 44Net only by implication: ARDC's walkthrough says "Any other reachable
IP address is fine, too" while setting up a first name
([Foundations: Identity and DNS](https://wiki.ampr.org/wiki/Foundations/Identity_and_DNS)). The self-check
warns about an address outside 44Net (`44.0.0.0/9`). A HAMNET address (`44.128.0.0/10`) is one of them: HAMNET
is a separate network that peers on the internet and on 44Net cannot reach, so it belongs in a `hamnet`
endpoint, not behind the 44Net name.

A member's [callsign verification](../day-to-day/callsign-verification.md) publishes its code at a name of its
own, `_aprscaching-verify.<call>.ampr.org`, so it never touches the identity record.

## 4. Configure the instance

Add the 44Net name to `FED_ENDPOINTS` **beside** the https endpoint: https stays the internet path, the
`44net` endpoint is the amateur-IP path. `net44 setup` does this for you, with `aprscaching.<call>.ampr.org`
as the default name (`--name` picks another). By hand, in `deploy/.env`:

```bash
FED_ENDPOINTS='[{"transport":"https","address":"https://aprs.example.net","priority":10},{"transport":"44net","address":"aprscaching.<call>.ampr.org","priority":20}]'
```

The `44net` address is a **name** under your call, never a raw 44.x address and never the base name; peers
reach it over plain http, or over https first when it is written `https://<name>`. It must be the name your TXT record sends peers to: the default name for the
callsign's record without `host=`, `host=` when it names one, or the record's own name for a record under a
label. An instance without 44Net leaves `FED_ENDPOINTS` as it is.

Make Caddy answer that name on the tunnel:

- **LAN, off-grid or Cloudflare Tunnel mode** (`DOMAIN=:80`): Caddy already answers plain http for any name
  on port 80. In Tunnel mode `compose.home.yml` publishes no ports, so publish port 80 on the tunnel address
  only, for example `ports: ["44.x.y.z:80:80"]` on the `caddy` service in a `compose.override.yml`. In
  `deploy/`, check the merged result with `docker compose config`.
- **Caddy with TLS** (`DOMAIN=<public host>`): Caddy answers only the names it serves. Add the 44Net name to
  `EXTRA_ORIGINS`: `https://aprscaching.<call>.ampr.org` gets a certificate, and the `44net` endpoint may then
  name `https://aprscaching.<call>.ampr.org`, which peers try over https first and over plain http after
  (`net44 setup --https` writes both). `http://aprscaching.<call>.ampr.org` serves the name as plain http
  only ([One instance, several addresses](several-addresses.md)).

Set `DOH_URL` if the default resolver (Cloudflare's DNS-over-HTTPS) is not reachable from the box. It must
be a DNS-over-HTTPS resolver that speaks the JSON API (`?name=&type=` with `accept: application/dns-json`)
and returns the AD flag. It serves adding peers by callsign, `ampr.org` callsign verification and the
self-check ([Configuration](../../reference/configuration.md)).

Restart the gateway after editing `deploy/.env`: in `deploy/`, `docker compose up -d`.

### TLS on the 44Net name

Federation over the `44net` endpoint needs no TLS: every record is signed. Browsers need https for passkeys,
device location, Web Serial, Web Bluetooth and web push. [One instance, several
addresses](several-addresses.md#get-a-certificate-for-the-44net-name) gets a certificate for the 44Net name and
serves it beside the internet name, with passkeys shared between both.

## 5. Verify with the self-check

**Check now** under **Instance admin → Federation → Publish your callsign identity** runs the self-check;
**Instance admin → Setup** shows the same check as an optional **44Net** item when `FED_ENDPOINTS` contains a
`44net` endpoint. It runs on demand, is read-only, and prints one pass, warn, fail or info line per check,
each failing one with a one-sentence fix that carries the exact value to publish and its name in the Portal:

- the `44net` endpoint is a name under `<call>.ampr.org`; the base name fails, with the default name as the
  fix;
- the 44Net host peers connect to has an A record on 44Net, inside `44.0.0.0/9`. A missing record fails; a
  HAMNET address (`44.128.0.0/10`) or any other address warns;
- the identity record parses and matches this instance's `INSTANCE` and current key. An instance under a
  label reads its own `_aprscaching.<label>` record first, then the callsign's. A `verify=` record does not
  count: the check names `_aprscaching-verify.<call>.ampr.org`, where it belongs;
- when both records carry a binding, whether the callsign's record sends peers to this host as another
  instance: a warning. A callsign record for your other instance is information;
- where the record sends peers matches where this instance is: its `44net` endpoint and its https origin;
- with `web=`, the descriptor names your call as its service call or its `FED_OPERATOR`, as a peer adding you
  requires. Neither naming it fails, with `FED_OPERATOR=<call>` as the fix;
- whether the DNS answer carried the DNSSEC AD flag, and whether the host has an AAAA record: information.

An instance without 44Net that has published nothing gets one information line with the record to publish:
publishing is optional.

The self-check looks up DNS through `DOH_URL` and builds the descriptor locally. It does not test
reachability: test inbound from outside as in [Check that it worked](44net.md#check-that-it-worked).
`deploy/aprscaching doctor` relays the same lines when it has `OPERATOR_SECRET`, and
`deploy/aprscaching net44 check` checks the A and `_aprscaching` records from the box and prints the records
to add.

## Peers by callsign

For an instance run by a ham, `<call>.ampr.org` is the recommended identity binding: the TXT record of
[step 3](#3-name-and-identity) ties a federation key to a callsign ARDC has verified. This section is the
other side: adding someone else's instance by their callsign.

**Adding a peer.** **Instance admin → Federation → Add a peer by callsign** (or `POST /federation/peers/44net`,
as the sysop or with the operator secret) takes a base callsign, or the host of an instance under a label, and:

1. resolves the TXT record through `DOH_URL`. A host without a record of its own takes the callsign's record
   when that one sends peers to it;
2. fetches the peer's descriptor where the record sends it. At a `web=` origin the descriptor must answer, name
   the instance of `inst=`, list `key=` among its active keys and name the callsign. Over 44Net (plain http) a descriptor that
   answers must match the same way; one that does not answer is not fatal, and the DNS key alone becomes the
   pin;
3. admits the peer automatically when the resolver validated the answer with DNSSEC (the AD flag). Without
   DNSSEC it shows the resolved binding and you confirm it once: a trust-on-first-use pin. `ampr.org` is not
   DNSSEC-signed ([DNSSEC](#dnssec)), so until ARDC signs the zone every admission is an operator
   confirmation.

**Key pinning and rotation.** The DNS key becomes the peer's key pin. From then on every sync verifies
against exactly that key, or a key the pin reaches through signed rotation records: the same rule as for
every peer ([Signed feeds](../../reference/federation-trust.md#signed-feeds)). A hijacked DNS record or host
cannot move the pin on its own. A peer that rotates its key updates its TXT record, so peers that add it
later pin the new key.

**Plain http, signed content.** A `44net` peer is contacted at `http://<host>`, or over https first when its
endpoint is written `https://<name>`. Nothing it carries needs to be secret. Its records are signed, and
corroboration questions and answers are signed and bound to each other, so a middlebox on the link can
neither forge nor replay them ([Cross-instance corroboration](../../reference/federation-trust.md#cross-instance-corroboration)).
`FED_CORROBORATION_SECRET` is sent only to https peers, so over a `44net` link the signatures carry the whole
weight.

**Identity, not trust.** The peer is stored with `verified_via = 'ardc-lot'` and enters **`unvetted`**:
mirrored, hidden on the map, and not counted toward Tier A until you promote it. `ardc-lot` records that ARDC
reviewed the licence behind the name; it never changes a trust tier, and neither does the 44.x address the
peer answers from. Adding a known peer again never changes its tier, so a `blocked` peer stays blocked. A
peer's instance id binds to one live row: a peer added by callsign with `web=` takes the row of its https
origin, so adding by callsign an instance you already follow at that origin records its callsign there. An
instance you follow at another URL is refused as a binding conflict until you block or remove one of the two.

## Next

- [Join the network](../federation/index.md): peers, trust and running federation safely.
- [HAMNET only](hamnet.md): what works when the instance has no internet path.
