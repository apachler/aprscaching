# 44Net name and identity

A `<call>.ampr.org` name ties your instance's federation key to your licensed callsign. This page publishes
that identity and checks it.

## 3. Name and identity

Publish these records in the Portal (**DNS → My subdomains → Resource Records**,
[DNS/Portal/Records](https://wiki.ampr.org/wiki/DNS/Portal/Records)). Enter only the left-hand part of
each name; `@` is the subdomain apex.

| Name | Type | Value | What it is for |
|------|------|-------|----------------|
| `<call>.ampr.org` | A | your 44.x Connect address | The host peers contact when the TXT record has no `host=` |
| `<sub>.<call>.ampr.org` | A | your 44.x Connect address | The host peers contact when its own TXT record, or the callsign's `host=`, names it |
| `_aprscaching.<call>.ampr.org` | TXT | `v=acs1; inst=<INSTANCE>; key=<federation public key>`, plus `; host=<sub>.<call>.ampr.org` when you publish under a subdomain | Your federation identity; peers add you by callsign |
| `_aprscaching.<sub>.<call>.ampr.org` | TXT | `v=acs1; inst=<INSTANCE>; key=<federation public key>` | The identity of an instance under a subdomain; peers add it by that host. One per instance, so one callsign can run several |
| `_aprscaching.<call>.ampr.org` | TXT | `v=acs1; verify=<code>` | Callsign verification only, while a challenge is open; it may sit beside the federation record |
| — | AAAA | not used | Onboarding and the self-check use the A record |
| `_acme-challenge.<host>` | TXT | the ACME DNS-01 token | Only for optional TLS by DNS-01 — see [TLS on the 44Net name](#tls-on-the-44net-name) |

You need either the first or the second A record, not both. No NS record, CNAME or delegation is needed.
Don't put `_aprscaching` behind a CNAME: callsign verification refuses an answer that went through an
alias, because the proof would then leave the ARDC zone.

**The TXT values.**

- `inst=` must equal this instance's `INSTANCE` exactly — by default `APP_URL`'s host.
- `key=` is the instance's current federation public key (raw Ed25519, base64url). It is printed by
  `node tools/fedkey/genkey.mjs` when you create the key, and the running instance publishes it as
  `publicKey` in `GET /.well-known/aprscaching`. **Instance admin → Federation → Be reachable on 44net**
  builds the record for you, and the Setup self-check ([step 5](#5-verify-with-the-self-check)) prints
  the exact value to publish when the record is missing or wrong.
- `host=` is optional. It must be `<call>.ampr.org` itself or a name under it; anything else — another
  call's zone, an unrelated domain, an invalid hostname — makes the whole record invalid, so a TXT
  record can never point federation traffic at a third party. `host=` changes only where peers connect.
  Identity, trust and the key pin stay the same.
- After [rotating the federation key](../../reference/federation-trust.md#signed-feeds), update `key=`. Peers that
  already follow you move their pin along your signed rotation record; a new peer compares the DNS key
  with your descriptor's active keys and refuses a key that is no longer among them.

**Worked example.** An operator publishes the instance under a subdomain of their call:

```
aprscaching.<call>.ampr.org   A    44.x.y.z
_aprscaching.<call>.ampr.org  TXT  "v=acs1; inst=aprs.example.net; key=<federation public key>; host=aprscaching.<call>.ampr.org"
```

Here `APP_URL` is `https://aprs.example.net`, so `inst=` is `aprs.example.net`, and `<call>.ampr.org`
itself stays free for other uses. Peers that add this instance by callsign contact
`http://aprscaching.<call>.ampr.org`.

**Several instances under one callsign.** A home station and a Pocket each get a name and a record of their
own:

```
<call>.ampr.org                      A    44.x.y.z
_aprscaching.<call>.ampr.org         TXT  "v=acs1; inst=aprs.example.net; key=<home key>"
pocket.<call>.ampr.org               A    44.x.y.w
_aprscaching.pocket.<call>.ampr.org  TXT  "v=acs1; inst=oe8apr-pocket; key=<Pocket key>"
```

Peers add the home station by callsign and the Pocket by its host, `pocket.<call>.ampr.org`, in the same
field under **Instance admin → Federation**. Both are recorded as instances of your callsign, so a peer's
corroboration quorum counts them as one voice. A name that carries two federation records is ambiguous:
the lookup lists them, and the peer's operator adds one by its host.

**How long DNS takes.**

- The Portal exports DNS changes **hourly**: "Expect up to about one hour for updates to reach the
  authoritative servers, plus any resolver caching based on TTL"
  ([DNS/Portal](https://wiki.ampr.org/wiki/DNS/Portal)). A new name appears within about an hour.
- A lookup that still returns NXDOMAIN after that means the record was not published: check in the
  Portal that it was saved, that its **Active** box is ticked, and that the subdomain is not still
  waiting for approval.
- A negative answer is cached for about 5 minutes (the zone's SOA), so a retry after publishing is not
  held up for long.
- The default TTL is **1 day** ([DNS/Portal/Records](https://wiki.ampr.org/wiki/DNS/Portal/Records)). A
  changed record can stay cached for up to that long wherever it was already resolved. Before a
  planned change — a new address, a rotated key — set a short TTL on the record (the Portal's TTL field
  accepts it, for example 300 seconds) and wait out the old TTL first.

`ampr.org` is served by `ns.ardc.net`, `ns1.de.ardc.net`, `ns2.us.ardc.net` and `a.gw4.uk` (the last is
not an ardc.net host; listed by a live NS query on 2026-09-30).

**DNSSEC.** "Currently, DNSSEC is not enabled for ampr.org. We expect to implement it in the future."
([DNS/Portal](https://wiki.ampr.org/wiki/DNS/Portal)). Until it is, no resolver sets the AD flag for
these records, so:

- adding a peer by callsign falls back to the operator's one-time confirmation (trust-on-first-use);
- `ampr.org` callsign verification falls back to several independent resolvers agreeing
  (`AMPR_DNS_RESOLVERS`, see [Callsign verification](../day-to-day/callsign-verification.md)).

A records outside 44/8 are accepted by the Portal only by implication: ARDC's walkthrough says "Any
other reachable IP address is fine, too" while setting up a first name
([Foundations: Identity and DNS](https://wiki.ampr.org/wiki/Foundations/Identity_and_DNS)). The
self-check warns about an address outside 44/8.

## 4. Configure the instance

Add the 44Net name to `FED_ENDPOINTS` **beside** the https endpoint — https stays the internet path, the
44net endpoint is the amateur-IP path. In `deploy/.env`:

```bash
FED_ENDPOINTS='[{"transport":"https","address":"https://aprs.example.net","priority":10},{"transport":"44net","address":"aprscaching.<call>.ampr.org","priority":20}]'
```

The 44net address is a **name**, never a raw 44.x address; peers reach it over plain http. It must be the
same host the TXT record points at (`host=`, else `<call>.ampr.org`).

Make Caddy answer that name on the tunnel:

- **LAN / off-grid or Cloudflare Tunnel mode** (`DOMAIN=:80`): Caddy already answers plain http for any
  name on port 80. In Tunnel mode `compose.home.yml` publishes no ports, so publish port 80 on the tunnel
  address only — for example `ports: ["44.x.y.z:80:80"]` on the `caddy` service in a
  `compose.override.yml` — and check the merged result with `docker compose config`.
- **Caddy with TLS** (`DOMAIN=<public host>`): Caddy answers only the names it serves. Add the 44Net name,
  `DOMAIN="aprs.example.net, aprscaching.<call>.ampr.org"`. Caddy then also fetches a certificate for it
  and redirects its http to https; federation fetches follow redirects, checking each hop.

Set `DOH_URL` if the default resolver (Cloudflare's DNS-over-HTTPS) is not reachable from the box. It
must be a DNS-over-HTTPS resolver that speaks the JSON API (`?name=&type=` with
`accept: application/dns-json`) and returns the AD flag; it serves adding peers by callsign, `ampr.org`
callsign verification and the self-check ([Configuration](../../reference/configuration.md)).

Restart the gateway after editing `.env`.

### TLS on the 44Net name

Federation over the 44net endpoint needs no TLS: every record is signed. Browsers are different —
passkeys, device location, Web Serial / Web Bluetooth and web push work only on https or `localhost`, so
members who open the plain-http 44Net name sign in with the operator's
[one-time link](../day-to-day/sign-in-links.md#off-grid-sign-in) and lose those features.

- Because a Connect address is publicly reachable (see [step 6](44net.md#6-who-can-reach-you)), Caddy's usual
  certificate challenge on port 80/443 can reach it. **Unverified** on a live Connect address; the first
  Caddy start with the name in `DOMAIN` settles it.
- **DNS-01 by hand, once per renewal.** The portal has no API, so each issue and each renewal takes one
  `_acme-challenge.<name>` TXT record entered by hand. Underscore labels work in the Portal; the hourly
  export makes each challenge wait up to an hour. Pocket's `extras/ampr-cert.sh` runs this with
  [lego](https://go-acme.github.io/lego/) (a Termux package): it prints the record, polls DNS until it is
  published, lets lego finish and warns 14 days before expiry ([Pocket on 44Net](../pocket/44net.md#pocket-on-44net)).
  **Unverified** end to end against the live portal. Delegating a subdomain to your own name server with an
  NS record ([DNS](https://wiki.ampr.org/wiki/DNS)) lets an ACME client with a DNS API renew unattended.
- **DNS-PERSIST-01** — one standing TXT record that authorises an ACME account for a name, so renewals
  need no new record — would suit the portal well. Let's Encrypt announced it in February 2026; it is not
  in production (September 2026), held until an open point in the IETF draft is settled. lego already has
  a `--dns-persist` option for it.
- **Over amateur RF, plain http stays.** A HAMNET radio link or a packet channel carries no encryption, so
  the plain-http 44Net name remains the way in there; https serves members who come over the internet.

## 5. Verify with the self-check

**Instance admin → Setup** shows an optional **44Net** item when `FED_ENDPOINTS` contains a `44net`
endpoint. It runs on demand, is read-only, and prints one pass, warn or fail line per check, each with a
one-sentence fix:

- the effective host (`host=`, else `<call>.ampr.org`) has an A record inside 44/8 — a missing record
  fails and names the record to add, an address outside 44/8 warns;
- the `_aprscaching` TXT record parses as `v=acs1; inst=…; key=…` and matches this instance's
  `INSTANCE` and current public key — otherwise it fails and prints the exact value to publish. For an
  endpoint under a subdomain the check reads its own `_aprscaching.<sub>.<call>.ampr.org` record first, then
  the callsign's. A `verify=` record at the same name does not count as the federation record;
- when both records carry a binding, whether the callsign's record sends peers to this host as another
  instance or with another key — a warning; a callsign record for your other instance is information;
- the instance's own descriptor lists the same 44net endpoint;
- whether the DNS answer carried the DNSSEC AD flag — information only;
- whether the effective host has an AAAA record — information only; onboarding uses the A record.

The self-check looks up DNS through `DOH_URL` and builds the descriptor locally. It does not test
reachability — step 6 is a manual test.

## Peers by callsign

For an instance run by a ham, `<call>.ampr.org` is the recommended identity binding. ARDC delegates that
name only after reviewing the holder's amateur licence, so a record the holder publishes under it ties a
federation key to a verified callsign. [44Net address](44net.md) is the step-by-step
recipe: the address, the DNS records, reachability and the self-check.

**Publishing.** The instance advertises its identity in one TXT record:

```
_aprscaching.<call>.ampr.org  TXT  "v=acs1; inst=<INSTANCE>; key=<federation public key>"
```

An optional `host=<name>` field names the host peers contact, when it is not `<call>.ampr.org` itself. It
must be `<call>.ampr.org` or a name under it; any other value invalidates the whole record. The same TXT
name may also carry a `v=acs1; verify=<code>` record for [callsign verification](../day-to-day/callsign-verification.md);
the two kinds sit side by side.

**Adding a peer by callsign.** **Instance admin → Federation** (or `POST /federation/peers/44net`, sysop
or operator secret) takes a base callsign and:

1. resolves the TXT record through `DOH_URL`;
2. fetches the peer's descriptor over plain http from the named host, when it is reachable. A descriptor
   whose instance id differs from `inst=`, or whose active keys don't include `key=`, is refused. An
   unreachable descriptor is not fatal: the DNS key alone becomes the pin;
3. admits the peer automatically when the resolver validated the answer with DNSSEC (the AD flag).
   Without DNSSEC it shows the resolved binding and the operator confirms it once — a trust-on-first-use
   pin. `ampr.org` is not DNSSEC-signed ([checked 2026-09-30](#3-name-and-identity)), so
   until ARDC signs the zone every admission is an operator confirmation.

**Key pinning and rotation.** The DNS key becomes the peer's key pin. From then on every sync verifies
against exactly that key, or a key the pin reaches through signed rotation records — the same rule as for
every peer ([Signed feeds](../../reference/federation-trust.md#signed-feeds)). A hijacked DNS record or host cannot move the pin on its own. A
peer that rotates its key updates its TXT record, so peers that add it later pin the new key.

**Plain http, signed content.** A 44net peer is contacted at `http://<host>`: amateur IP space has no
public certificate authority, and nothing it carries needs to be secret. Its records are signed, and
corroboration questions and answers are signed and bound to each other, so a middlebox on the link can
neither forge nor replay them ([Cross-instance corroboration](../../reference/federation-trust.md#cross-instance-corroboration)).
`FED_CORROBORATION_SECRET` is sent only to https peers, so over a 44net link the signatures carry the whole
weight.

**Identity, not trust.** The peer is stored with `verified_via = 'ardc-lot'` and enters **`unvetted`**:
mirrored, hidden on the map, and not counted toward Tier A until you promote it. `ardc-lot` records that
ARDC reviewed the licence behind the name — it never changes a trust tier, and neither does the 44.x address
the peer answers from. Re-adding a known peer never changes its tier, so a `blocked` peer stays blocked. A
peer's instance id binds to one live row: if you already follow the instance at its https URL, adding it by
callsign is refused as a binding conflict until you block or remove one of the two.

## Next

- [HAMNET only](hamnet.md).
