# One instance, several addresses

This page shows you how to reach one instance on its internet name, its 44Net name and a HAMNET address at the
same time. It is for a sysop of the Docker stack whose instance already runs on its main address (`APP_URL`). At
the end each address serves the app, members can sign in on each, and peers can reach the instance on each
network they have a route to.

## Before you start

- The instance runs on its main https address, such as `https://aprs.example.net` ([Self-host with
  Docker](../install/self-host-docker.md)).
- For the 44Net name: the tunnel is up and the name's A record is published ([44Net address](44net.md),
  [44Net name and identity](44net-identity.md)).
- For HAMNET: a HAMNET address routed to this box, and, for a name, a record in your region's HAMNET DNS.

## How the addresses differ

The scheme of each address decides what it can do: an `https://` address has a certificate, an `http://` one has
none. Which network the address is on changes nothing else.

| | Internet, https (`APP_URL`) | 44Net name, https | HAMNET, plain http |
|---|---|---|---|
| Example | `https://aprs.example.net` | `https://aprscaching.oe8apr.ampr.org` | `http://aprscaching.oe8xyz.hamnet.example`, `http://44.143.1.2` |
| Sign in by email link | Yes | Yes | Yes, with a mail server reachable on HAMNET ([HAMNET only](hamnet.md)) |
| Sign in with the sysop's one-time link | Yes | Yes | Yes |
| Passkeys | Yes | Yes, as a related origin (see below) | No: browsers offer passkeys only on a secure page |
| Instance admin | Yes | Yes | Only on an instance with no https address |
| Device location (Tier B finds) | Yes | Yes | No |
| Radio in the browser (Web Serial, Web Bluetooth) | Yes | Yes | No |
| Web push | Yes | Yes | No: push services are on the internet |
| Federation | `https` endpoint | `44net` endpoint, https then plain http | `hamnet` endpoint, for peers with a route to HAMNET |

Each address keeps its own session: signing in on the HAMNET address does not sign you in on the internet one.
The session names the address it was issued on and is honoured there alone, so a session issued over plain
http is never accepted over https, even on the same host name. Sign-in links, the confirm step and links into
the app stay on the address you started on. The sitemap, the digest mail and the federation descriptor's
identity always name `APP_URL`.

Instance admin needs a session issued on an https address. A sysop signed in on a plain-http address is an
ordinary member there: an http session crosses the network unencrypted. An instance with no https address at
all (HAMNET alone) is administered over plain http, since that is the only way in.

A request on a host that is neither `APP_URL` nor listed is answered as if it came to `APP_URL`. A link built
from a host header anyone can send would carry its sign-in token to that host.

## Every combination

Any of the three can be `APP_URL`, the main address, and any of the others can join it in `EXTRA_ORIGINS`. Each
address works as the table above says, whatever the combination. What changes with the choice of `APP_URL`:

| Addresses | Passkeys | Notes |
|---|---|---|
| Internet alone | Yes | The usual public instance |
| 44Net alone (`APP_URL=https://aprscaching.<call>.ampr.org`) | Yes | `setup.sh --domain aprscaching.<call>.ampr.org`; the certificate comes from Caddy's challenge on the Connect address (**Unverified**) or DNS-01 by hand |
| HAMNET alone (`APP_URL=http://<HAMNET name or 44.x address>`) | No | `setup.sh --lan-host <HAMNET name or address>`; no public CA issues a certificate inside HAMNET, so it stays plain http. Members sign in by email link (a mail server on HAMNET) or the sysop's link |
| Internet + 44Net | Yes, on both | Passkeys belong to `APP_URL`'s host; the other one is a related origin |
| Internet + HAMNET | Yes, on the internet address | On HAMNET: email or the sysop's link |
| 44Net + HAMNET | Yes, on the 44Net address | The usual shape of a station without an internet name |
| All three | Yes, on both https addresses | The worked example below |

When `APP_URL` is the plain-http HAMNET address, `RP_ID` follows the first https address in `EXTRA_ORIGINS`, so
passkeys still work there. Every combination, with each of its addresses as `APP_URL`, is covered by the gateway's
tests (`servers/node/test/several_addresses.test.ts`): sign-in links, cookies, the related-origins file and passkey
registration on each address. Real 44Net and HAMNET routing, Caddy's certificate for a Connect address and the
browsers' related-origin support are not tested against live infrastructure.

## Steps

The worked example: OE8APR runs `https://aprs.example.net` on the internet, `https://aprscaching.oe8apr.ampr.org`
on 44Net and `http://44.143.1.2` on HAMNET.

1. List the further addresses in `deploy/.env`, comma-separated, each a bare origin with no path:

    ```bash
    EXTRA_ORIGINS=https://aprscaching.oe8apr.ampr.org,http://44.143.1.2
    ```

    `deploy/setup.sh --extra-origins` writes the same line, and `deploy/aprscaching net44 setup --https` adds the
    44Net name. Leave `APP_URL` as it is: it stays the main address.

2. Publish the 44Net name for federation with its certificate, and the HAMNET address, in `FED_ENDPOINTS`:

    ```bash
    FED_ENDPOINTS='[{"transport":"https","address":"https://aprs.example.net","priority":10},{"transport":"44net","address":"https://aprscaching.oe8apr.ampr.org","priority":20},{"transport":"hamnet","address":"44.143.1.2","priority":30}]'
    ```

    `net44 setup --https` writes the `44net` entry. The `_aprscaching` TXT record stays as
    [44Net name and identity](44net-identity.md#3-name-and-identity) describes: `host=` takes the name, never
    `https://`.

3. Restart the stack: in `deploy/`, `docker compose up -d`. Caddy serves `DOMAIN` and every `https://` address
   with a certificate it fetches itself, and every `http://` address as plain http, with no certificate and no
   redirect to https.

## Get a certificate for the 44Net name

Federation over the `44net` endpoint needs no TLS: every record is signed. Browsers need it for passkeys, device
location, Web Serial, Web Bluetooth and web push.

- **Caddy's own challenge.** A Connect address is reachable from the internet ([Who can reach
  you](44net.md#who-can-reach-you)), so Caddy's usual challenge on port 80 or 443 reaches it once the name's A
  record is published. **Unverified** on a live Connect address; the first Caddy start with the name in
  `EXTRA_ORIGINS` settles it, and `deploy/aprscaching doctor` reports the certificate.
- **DNS-01 by hand, once per renewal.** The Portal has no API, so each issue and each renewal takes one
  `_acme-challenge.<name>` TXT record entered by hand. Underscore labels work in the Portal; the hourly
  export makes each challenge wait up to an hour. Pocket's `extras/ampr-cert.sh` runs this with
  [lego](https://go-acme.github.io/lego/) (a Termux package): it prints the record, polls DNS until it is
  published, lets lego finish and warns 14 days before expiry ([Pocket on 44Net](../pocket/44net.md#pocket-on-44net)).
  **Unverified** end to end against the live Portal. Delegating a subdomain to your own name server with an
  NS record ([DNS](https://wiki.ampr.org/wiki/DNS)) lets an ACME client with a DNS API renew unattended.
- **DNS-PERSIST-01**, one standing TXT record that authorises an ACME account for a name so renewals need no
  new record, would suit the Portal well. Let's Encrypt announced it in February 2026; it is not in
  production (September 2026), held until an open point in the IETF draft is settled. lego already has a
  `--dns-persist` option for it.
- **Over amateur RF, plain http stays.** A HAMNET radio link or a packet channel carries no encryption, so a
  plain-http address remains the way in there.

In Tunnel mode (`compose.home.yml`) Caddy publishes no ports, so its challenge cannot reach an https address:
publish ports 80 and 443 on the address the name points at, for example in a `compose.override.yml`.

## Passkeys on every https address

A passkey belongs to one relying party, `RP_ID`, which is `APP_URL`'s host, or the first https address's when
`APP_URL` is plain http. The instance keeps that one relying
party on every https address, so a passkey made on the internet name also signs in on the 44Net name. A browser
on an address outside `RP_ID`'s domain fetches `https://<RP_ID>/.well-known/webauthn`, where the instance lists
`APP_URL` and every https address of `EXTRA_ORIGINS` as related origins, and accepts the relying party there.

- Chrome and Edge support related origins from version 128, Safari from version 18. **Unverified** for
  Firefox: a browser without support refuses the passkey on the other address, and email or the sysop's link
  still work there.
- The browser asks `RP_ID`'s own address, so `APP_URL` must be reachable from the device. A phone with only a
  HAMNET route never gets there, and plain http offers no passkeys anyway.
- An `RP_ID` set to a parent domain (`example.net` for `aprs.example.net`) needs that domain to serve the
  same file; the instance serves it only on its own addresses.

On a plain-http address the sign-in panel shows passkeys as unavailable and says why. Members sign in with an
email link or the sysop's [one-time link](../day-to-day/sign-in-links.md#off-grid-sign-in); the sysop's
[`signin-link.mjs`](../../reference/cli.md#signin-link) names the HAMNET address with `--link-origin`.

## Federation over several addresses

Peers that added this instance by URL, from `FED_PEERS`, the registry or discovery learn the addresses of
`FED_ENDPOINTS` from its descriptor on every sync; a peer that added it by callsign uses the addresses its DNS
record names. Peers try them in priority order and keep the first that answers, and the address a peer added
this instance under stays its last resort:

- a `44net` endpoint with `https://` is tried over https, then over plain http on the same name;
- a `hamnet` endpoint is tried with a 2-second timeout: most peers have no route to HAMNET and move on to the
  next address;
- an address that answers with an error is kept: the peer is there.

Records are signed whatever the path, so neither the fall back to plain http nor HAMNET changes trust
([Federation wire format](../../reference/federation-wire.md#peer-endpoints)).

## Check that it worked

- `deploy/aprscaching doctor` checks each address: it is listed once, it resolves, its `/health` answers from
  this box as this gateway, an https one has a valid certificate, and an http one is not on the internet
  ([troubleshooting](../troubleshooting.md#originsdns)).
- From a device on each network, open the address, sign in, and reload: you stay signed in.
- `curl -fsS https://aprs.example.net/.well-known/webauthn` lists the https addresses.

## Next

- [HAMNET only](hamnet.md): what works when the instance has no internet path.
- [44Net name and identity](44net-identity.md): let peers add the instance by callsign.
