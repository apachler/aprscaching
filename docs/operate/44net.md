# Run an instance on 44Net

**44Net** (AMPRNet) is the amateur-radio IPv4 space `44.0.0.0/8`, administered by
[ARDC](https://www.ardc.net/). For an aprscaching instance it gives two things:

- **Reachability.** *44Net Connect* gives one machine a static 44.x address over a WireGuard tunnel, so
  the box is reachable without port forwarding — behind CGNAT, on a mobile or satellite link, or on a
  home line with a changing address.
- **Identity.** ARDC issues `<call>.ampr.org` only after checking the operator's licence, so a record
  published under that name binds a federation key to a verified callsign.

It adds no **trust**. A 44.x source address, the WireGuard tunnel and a HAMNET path are transports;
authenticity comes only from signatures and pinned keys, and a peer's trust tier stays the operator's
decision ([transport is not trust](../concepts.md#transport-is-not-trust)). The RF ingest stays on your
own equipment: 44Net reaches that equipment, it is never a reason to move the ingest anywhere else.

This page is a recipe for the [Self-host](deployment.md#self-host) shape. Statements about ARDC's
services link the ARDC page they come from, checked on 2026-09-30 (the full list is under
[Sources](#sources)); anything those pages do not settle is marked **Unverified**, with what would
settle it.

## 1. Get an address

Follow ARDC's own instructions rather than a copy here — they change:

1. Create a **44Net Portal** account at [portal.ampr.org](https://portal.ampr.org/) and verify your
   callsign through the Portal
   ([Verification](https://wiki.ampr.org/wiki/Verification)). A callsign subdomain
   (`<call>.ampr.org`) is approved automatically once the callsign is verified; any other name goes to
   ARDC staff for review ([DNS/Portal/Subdomains](https://wiki.ampr.org/wiki/DNS/Portal/Subdomains)).
2. Register for **44Net Connect** at [connect.44net.cloud](https://connect.44net.cloud/) and request a
   **single device tunnel** for the self-host machine. It issues one IPv4 address and one IPv6 address
   per device, and a WireGuard configuration for it
   ([44Net Connect](https://wiki.ampr.org/wiki/44Net_Connect),
   [Single Device Tunnel](https://wiki.ampr.org/wiki/44Net_Connect/Single_Device_Tunnel),
   [ARDC: Introducing 44Net Connect](https://www.ardc.net/introducing-44net-connect-a-simpler-way-to-access-44net/)).

The IPv4 address is static and works behind NAT and CGNAT. **Unverified:** the cost — ARDC's pages
state no price; the Connect terms are what settle it.

IPv6: Connect also issues an IPv6 address per device, but its prefix and whether it is production
space are **Unverified** (ARDC's pages differ). Federation onboarding and everything on this page use the
IPv4 A record; don't rely on the IPv6 address.

## 2. Bring the tunnel up

Install a standard WireGuard client on the self-host machine and load the configuration Connect issued
(`wg-quick up <name>` on Linux; the interface takes the configuration file's name). ARDC's
[Quick Start](https://wiki.ampr.org/wiki/44Net_Connect/Quick_Start) covers the clients and routers it
supports; a community guide from AllStarLink
([44Net Connect](https://allstarlink.github.io/adv-topics/44net-connect/)) shows one Linux install.

Check that the address is up: `ip addr show <name>` lists your 44.x address.

WireGuard encrypts the leg between your machine and ARDC's Connect endpoint, which runs over the
internet. Beyond that endpoint, and on any amateur radio link, the traffic is plain.

## 3. Name and identity

Publish these records in the Portal (**DNS → My subdomains → Resource Records**,
[DNS/Portal/Records](https://wiki.ampr.org/wiki/DNS/Portal/Records)). Enter only the left-hand part of
each name; `@` is the subdomain apex.

| Name | Type | Value | What it is for |
|------|------|-------|----------------|
| `<call>.ampr.org` | A | your 44.x Connect address | The host peers contact when the TXT record has no `host=` |
| `<sub>.<call>.ampr.org` | A | your 44.x Connect address | The host peers contact when the TXT record names it with `host=` |
| `_aprscaching.<call>.ampr.org` | TXT | `v=acs1; inst=<INSTANCE>; key=<federation public key>`, plus `; host=<sub>.<call>.ampr.org` when you publish under a subdomain | Your federation identity |
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
- After [rotating the federation key](../guides/federation.md#signed-feeds), update `key=`. Peers that
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
  (`AMPR_DNS_RESOLVERS`, see [Administration](administration.md#callsign-verification)).

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
callsign verification and the self-check ([Configuration](../reference/configuration.md)).

Restart the gateway after editing `.env`.

### TLS on the 44Net name

Federation over the 44net endpoint needs no TLS: every record is signed. Browsers are different —
passkeys, device location, Web Serial / Web Bluetooth and web push work only on https or `localhost`, so
members who open the plain-http 44Net name sign in with the operator's
[one-time link](first-hour.md#off-grid-sign-in) and lose those features.

- Because a Connect address is publicly reachable (see [step 6](#6-who-can-reach-you)), Caddy's usual
  certificate challenge on port 80/443 can reach it. **Unverified** on a live Connect address; the first
  Caddy start with the name in `DOMAIN` settles it.
- **DNS-01 by hand, once per renewal.** The portal has no API, so each issue and each renewal takes one
  `_acme-challenge.<name>` TXT record entered by hand. Underscore labels work in the Portal; the hourly
  export makes each challenge wait up to an hour. Pocket's `extras/ampr-cert.sh` runs this with
  [lego](https://go-acme.github.io/lego/) (a Termux package): it prints the record, polls DNS until it is
  published, lets lego finish and warns 14 days before expiry ([Pocket on 44Net](pocket.md#pocket-on-44net)).
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
  `INSTANCE` and current public key — otherwise it fails and prints the exact value to publish. A
  `verify=` record at the same name does not count as the federation record;
- the instance's own descriptor lists the same 44net endpoint;
- whether the DNS answer carried the DNSSEC AD flag — information only;
- whether the effective host has an AAAA record — information only; onboarding uses the A record.

The self-check looks up DNS through `DOH_URL` and builds the descriptor locally. It does not test
reachability — step 6 is a manual test.

## 6. Who can reach you

**A 44Net Connect address is reachable from the whole internet, and ARDC filters nothing.** ARDC's Quick
Start: "Your device is now reachable on the Internet at its 44Net IP address"; Firewalling Basics: 44Net
Connect "does not inspect, filter, or block any traffic directed towards 44Net devices"
([Quick Start](https://wiki.ampr.org/wiki/44Net_Connect/Quick_Start),
[Firewalling Basics](https://wiki.ampr.org/wiki/Firewalling_Basics)). The addresses are announced from
ARDC's own network ([Guide for ISPs](https://wiki.ampr.org/wiki/Guide_for_ISPs)). Scanners find a new
address quickly, so the firewall on the tunnel is yours to set:

- Allow only what Caddy serves — TCP 80 and 443 — on the tunnel interface, plus replies to connections
  the box opens, and drop everything else arriving on it. With nftables, for a tunnel named `wg44`:

    ```
    table inet tunnel44 {
      chain input {
        type filter hook input priority filter; policy accept;
        iifname "wg44" ct state established,related accept
        iifname "wg44" tcp dport { 80, 443 } accept
        iifname "wg44" drop
      }
    }
    ```

- Docker publishes container ports through its own rules, which an `input` chain like this does not see.
  The stack publishes only Caddy's 80 and 443; bind any other port you publish (a MeshCom or AXUDP
  listener) to a specific LAN or tunnel address, never to all addresses.
- Never expose SSH, the gateway's port 8080 or an ingest port on the tunnel.

**Test inbound from outside.** Take a phone, turn Wi-Fi off, and open
`http://aprscaching.<call>.ampr.org/health` over mobile data (or `curl -fsS` it from a machine on another
network). Outbound traffic working proves nothing about inbound. That a Connect address is reachable from
a phone on mobile data is what ARDC's documentation states (verified against the pages above); if the test
fails while the tunnel is up:

- your own firewall or router is blocking inbound traffic, and the box is reachable only outbound — it
  can still pull from peers and push to a hub ([Reaching firewalled peers](../guides/federation.md#reaching-firewalled-peers));
- or replies leave by the wrong route: a tunnel that carries only 44Net traffic (a "split tunnel",
  [Single Device Tunnel](https://wiki.ampr.org/wiki/44Net_Connect/Single_Device_Tunnel)) must still send
  replies from the 44.x address back through the tunnel. **Unverified:** whether the configuration Connect
  issues does this by default; `ip route get <phone's address> from 44.x.y.z` on the box shows which way a
  reply goes.

**HAMNET.** HAMNET is a separate amateur IP backbone, mostly `44.128.0.0/10` and not announced to the
internet. ARDC: "A subnet reachable via Connect is not automatically part of the Mesh. A Mesh network does
not automatically appear via BGP." ([Decentralization](https://wiki.ampr.org/wiki/Decentralization)).
Whether a HAMNET station can reach a Connect address, and the other way round, is **Unverified**; it
depends on the regional HAMNET gateway, and a test from a HAMNET station settles it for your region.

## 7. What 44Net does and doesn't give you

!!! note "What 44Net does and doesn't give you"
    - **It gives** a static address reachable without port forwarding, and a callsign-verified name to
      publish your federation key under.
    - **WireGuard encrypts only the leg to ARDC.** Between peers, 44Net traffic is plain http. Anything that
      crosses amateur RF — a HAMNET radio link, a packet channel — is signed, never encrypted, under your
      national amateur rules ([compliance](rf-regulatory.md#no-encryption-on-the-air-sign-never-conceal)).
      No ARDC statement on encryption over its tunnels versus RF was found.
    - **Authenticity comes from signatures,** not from the path: every record is signed, and corroboration
      questions and answers are signed and bound to each other, so a middlebox on a plain-http link can
      neither forge nor replay them ([Federation](../guides/federation.md#cross-instance-corroboration)).
    - **A 44.x address proves nothing** about any single packet. A source address is not a signature, so
      aprscaching never derives identity or trust from one.
    - **A verified name is identity, not trust.** A peer added by callsign is recorded as
      `verified_via = 'ardc-lot'` and enters `unvetted`, like any discovered peer. Whether its records and
      corroboration count is your decision under **Instance admin → Federation**.

## Off the internet: what works over HAMNET only

A 44.x instance reached over HAMNET with no internet path runs, but everything that calls a third-party
service stops. The table lists each dependency and the workaround.

| Feature | Works HAMNET-only? | Workaround |
|---------|--------------------|------------|
| The app itself — scripts, styles, fonts, the MapLibre worker, the in-app manual | Yes | Bundled and served by the instance; nothing loads from a CDN |
| Base map, *Modern* theme (default OpenFreeMap vector style) | No | Build the SPA with `VITE_BASEMAP=offline` (the self-contained grid), use the *Phosphor* theme (its grid is built in), or point `VITE_BASEMAP_STYLE` at a style served inside HAMNET. Instance-served tile packs are [planned](https://github.com/apachler/aprscaching/blob/dev/TODO.md#future-ideas-not-yet-built-still-wanted). While the online style cannot load, the map fetches caches only after the first pan or zoom |
| Topo and satellite layers (OpenTopoMap, EOX) | No | Stay on the vector or offline base map; both layers are opt-in |
| "Navigate" links (Google Maps, Apple Maps, OpenStreetMap) | No | They are plain links; the cache's coordinates stay on the sheet |
| Embeddable map widget (`/embed`) | Works with `BASEMAP_STYLE=offline` or a HAMNET style | MapLibre comes from the instance's own web build. The basemap is the gateway's `BASEMAP_STYLE`: `offline` draws the self-contained grid, or point it at a style served inside HAMNET ([configuration](../reference/configuration.md#gateway-read-api-spots-emailpush)) |
| Passkeys, device location (Tier B finds), Web Serial / Web Bluetooth radio, web push | Only over https | TLS on the 44Net name ([above](#tls-on-the-44net-name)); over plain http members sign in with the operator's [one-time link](first-hour.md#off-grid-sign-in) and log finds unsigned |
| Email sign-in links and the watch digest (Resend API) | No | Passkeys, or the operator's one-time link |
| Web push delivery (the browser vendor's push service) | No | The in-app watchlist |
| APRS-IS feed and uplink (`rotate.aprs2.net` by default) | No | Set `APRSIS_HOST` to an APRS-IS server reachable on HAMNET, if your region runs one (**Unverified** per region). RF from your own TNC is unaffected |
| RF ingest from your own radio | Yes | The [off-grid](rf-ingest.md#off-grid) shape: the ingest box and a local gateway on one machine, `INGEST_URL=http://localhost:8787/ingest` |
| Federation with https peers on the internet | No | Peers with a 44net endpoint reachable over HAMNET (**Unverified**, see [HAMNET](#6-who-can-reach-you)); packet carriers (AX.25, NET/ROM, FBB) need no IP at all ([wire format](../reference/federation-wire.md)). Discovery learns only https peers |
| Adding a peer by callsign, `ampr.org` callsign verification, the 44Net self-check | No, with the default resolvers | Set `DOH_URL` (and `AMPR_DNS_RESOLVERS`) to DNS-over-HTTPS resolvers reachable on HAMNET that can still reach ARDC's name servers; otherwise do these while connected. Verification over RF works offline |
| Instance registry located by `FED_REGISTRY_DNS` | No | This lookup always asks Cloudflare's resolver and ignores `DOH_URL`. Set `FED_REGISTRY` to a document URL reachable on HAMNET instead; the last good document keeps binding meanwhile |
| Source link (`/source` → `SOURCE_REPO`, GitHub by default) | The link works, the target doesn't | Point `SOURCE_REPO` at a mirror reachable on HAMNET — any forge with `<repo>/tree/<commit>` URLs (AGPL §13) |
| Activity spots, licence-register refresh, heritage and OpenCaching imports | No | Optional; they resume when a path to the internet returns |

## Sources

ARDC pages, each checked on 2026-09-30:

- [44Net Connect](https://wiki.ampr.org/wiki/44Net_Connect) — what Connect is; a native 44Net host on the
  public internet.
- [44Net Connect/Quick Start](https://wiki.ampr.org/wiki/44Net_Connect/Quick_Start) — sign-up, clients,
  inbound reachability.
- [44Net Connect/Single Device Tunnel](https://wiki.ampr.org/wiki/44Net_Connect/Single_Device_Tunnel) —
  one IPv4 and one IPv6 address per device; split tunnels.
- [Ways to Connect](https://wiki.ampr.org/wiki/Ways_to_Connect) — services on a single-device tunnel are
  directly accessible from the internet.
- [Firewalling Basics](https://wiki.ampr.org/wiki/Firewalling_Basics) — Connect does not filter traffic.
- [Guide for ISPs](https://wiki.ampr.org/wiki/Guide_for_ISPs) — ARDC's network originates Connect's space.
- [Verification](https://wiki.ampr.org/wiki/Verification) — Portal verification levels.
- [DNS](https://wiki.ampr.org/wiki/DNS), [DNS/Portal](https://wiki.ampr.org/wiki/DNS/Portal),
  [DNS/Portal/Subdomains](https://wiki.ampr.org/wiki/DNS/Portal/Subdomains),
  [DNS/Portal/Records](https://wiki.ampr.org/wiki/DNS/Portal/Records) — record types, hourly export,
  TTL, DNSSEC status, delegation.
- [Foundations: Identity and DNS](https://wiki.ampr.org/wiki/Foundations/Identity_and_DNS) — a first
  hostname; other reachable addresses.
- [Decentralization](https://wiki.ampr.org/wiki/Decentralization) — Connect and the HAMNET mesh are
  routed separately.
- [ARDC: Introducing 44Net Connect](https://www.ardc.net/introducing-44net-connect-a-simpler-way-to-access-44net/)
  (2025-12-10) — the service announcement.

No public ARDC API for Portal DNS or Connect provisioning was found, so every step above is manual.
