# One-time sign-in links

Where passkeys cannot work (plain http on a LAN, HAMNET or a hotspot), members sign in with a one-time link
from the sysop.

## Off-grid sign-in

A box reached over plain http (`APP_URL=http://192.168.1.10`) has no passkeys — browsers allow them only on
https or `localhost` — and usually no email. The operator signs people in with a one-time link:

```bash
docker compose exec gateway node tools/admin/signin-link.mjs OE8APR
```

It prints a link to `APP_URL` that opens a confirm page; **Sign in** there opens a session for the account
holding the call's base call, or creates one, unverified, for a new call. Hand the link to the person it is
for — show it on their screen, send it as a QR code, or type it on their device.

How it is kept safe:

- **Only the operator secret mints a link**, and only on the gateway host (the script reaches it over
  loopback). The ingest secret cannot.
- **Scope.** On an off-grid instance the link serves any call, since it is the only way in. Where passkeys
  (https `APP_URL`) or email work, it serves only `ADMIN_CALLSIGNS` calls, so a leaked operator secret cannot
  open a member's account there.
- **Single use, 15 minutes.** The token is spent on the first confirm and refused after it expires.
- **No login CSRF.** Opening the link signs nobody in; only the confirm page's own form (a same-origin POST)
  spends it, so a page that makes a browser load someone's link cannot sign that browser in.
- **Not a verification.** A link opens an account; it never proves control of a callsign. Transmit stays
  gated on control-verification.
- **The link is a bearer credential** until it is used or expires: whoever opens it first gets the session.
  Over plain http the session cookie travels unencrypted on the LAN, like everything else there.

### Visitors on the hotspot

A station that is its own Wi-Fi hotspot (a phone or a field box) keeps `APP_URL=http://localhost:8787`, so
the owner signs in with a passkey on the station itself. Visitors join the hotspot and open the station
over https: the Node server's own listener on `HTTPS_PORT`, with a certificate for the station's hotspot
address ([configuration](../../reference/configuration.md)); on a phone, `deploy/pocket/tls.sh` sets it all up and
keeps the certificate current as the hotspot address changes. Their browser warns until they install the
station's CA from `http://<station address>:8787/pocket-ca.crt`, or they click through the warning. Passkeys
do not work at an IP address, so a visitor signs in with a one-time link the operator mints for their
call:

```bash
OPERATOR_SECRET=… node tools/admin/signin-link.mjs --link-origin https://192.168.43.1:8443 --qr OE8VIS
```

- **The station opts in.** `OPERATOR_LINKS_FOR_ANY_CALL=1` lets the link serve a call outside
  `ADMIN_CALLSIGNS` on an instance that has passkeys; without it the gateway refuses. It also lets a leaked
  operator secret open any account, so it belongs only on a station the operator alone runs.
- **The link names only the hotspot origin.** `--link-origin` accepts `APP_URL`, or `https` at a private IPv4
  address (10/8, 172.16/12, 192.168/16) on `HTTPS_PORT` while that listener runs. Any other origin is
  refused.
- **The session lives on that origin.** The visitor confirms on the hotspot origin and returns there; a page
  from any other origin, including another device on the hotspot, cannot confirm the link.
- **Nothing about trust changes.** A visitor's new account is unverified, logs finds only under the
  visitor's own call, and reaches no tier a signed-in user could not reach before.

## Next

- [Callsign verification](callsign-verification.md).
