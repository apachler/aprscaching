# One-time sign-in links

This page is for the sysop. It shows how to sign a person in with a one-time link where passkeys cannot work:
plain http on a LAN, HAMNET, or visitors on a station's hotspot. At the end the person has a session on the
instance.

## Before you start

- The instance's `OPERATOR_SECRET`. Only it mints a link; the ingest secret cannot.
- A shell on the gateway host. The tool reaches the gateway on this host by default
  (`http://127.0.0.1:$PORT`, port 8787); `BASE` names another address.
- The callsign of the person you sign in.

## Off-grid sign-in

A box reached over plain http (`APP_URL=http://192.168.1.10`) has no passkeys, because browsers allow them only
on https or `localhost`. It usually has no email either. The sysop signs people in with a one-time link.

1. Mint the link. With the Docker stack, run this in `deploy/`:

    ```bash
    docker compose exec gateway node tools/admin/signin-link.mjs OE8APR
    ```

    From a checkout, run `OPERATOR_SECRET=… node tools/admin/signin-link.mjs OE8APR` in its root directory. On
    Pocket, run `bash ~/aprscaching/deploy/pocket/signin-link.sh OE8APR` in Termux; it reads the secret from
    the station's `.env`. `--qr` also prints the link as a QR code.

2. Hand the link to the person it is for: show it on their screen, let them scan the QR code, or type it on
   their device. Never send it over a channel others read.
3. They open it and select **Sign in** on the confirm page. The session opens for the account that holds the
   call's base call, or for a new, unverified account when nobody holds the call yet.

## How a link stays safe

- **Scope.** On an off-grid instance, with neither passkeys nor email, a link serves any call, since it is the
  only way in. Where passkeys (an https `APP_URL`) or email work, it serves only `ADMIN_CALLSIGNS` calls, so a
  leaked operator secret cannot open a member's account there. `OPERATOR_LINKS_FOR_ANY_CALL=1` lifts that
  limit ([Visitors on the hotspot](#visitors-on-the-hotspot)).
- **Single use, 15 minutes.** The first confirm spends the token; after 15 minutes it is refused.
- **No login CSRF.** Opening the link signs nobody in. Only the confirm page's own form, a same-origin POST,
  spends it, so a page that makes a browser load someone's link cannot sign that browser in.
- **The operator's own call.** An `ADMIN_CALLSIGNS` call opens only through this link or a proof of control;
  an ordinary sign-up with it is refused, so nobody registers it before the operator does.
- **Not a verification.** A link opens an account; it never proves control of a callsign. Transmit stays gated
  on control-verification ([Callsign verification](callsign-verification.md)).
- **A bearer credential.** Until it is used or expires, whoever opens the link first gets the session. Over
  plain http the session cookie travels unencrypted on the LAN, like everything else there.

### Visitors on the hotspot

A station that is its own Wi-Fi hotspot, such as a phone or a field box, keeps `APP_URL=http://localhost:8787`.
The owner signs in with a passkey on the station itself. A visitor's browser grants location and keeps a
sign-in only on a secure origin, and `http://<hotspot address>:8787` is not one. So visitors join the hotspot
and open the station over https: the Node server's own listener on `HTTPS_PORT`, with a certificate for the
station's private address ([Configuration](../../reference/configuration.md)).

On a phone, `deploy/pocket/tls.sh` sets this up and keeps the certificate current as the hotspot address
changes ([Visitors over https](../pocket/field-station.md#visitors-over-https)). Elsewhere you set `HTTPS_PORT`,
`TLS_CERT` and `TLS_KEY` yourself.

The visitor's browser warns about the certificate until they install the station's CA from
`http://<station address>:8787/pocket-ca.crt`, or they accept the warning once. Chrome and Brave trust an
installed CA; Firefox for Android does only with *Use third party CA certificates* in its secret settings.

Passkeys do not work at an IP address, so a visitor signs in with a link the sysop mints for the visitor's own
call:

```bash
OPERATOR_SECRET=… node tools/admin/signin-link.mjs --link-origin https://192.168.43.1:8443 --qr OE8VIS
bash ~/aprscaching/deploy/pocket/signin-link.sh --hotspot OE8VIS      # the same on Pocket
```

On Pocket, `--hotspot` names the station's https origin and prints a QR code; `--ip <address>` picks the
address when the phone has several private ones.

- **The station opts in.** `OPERATOR_LINKS_FOR_ANY_CALL=1` lets the link serve a call outside
  `ADMIN_CALLSIGNS` on an instance that has passkeys; without it the gateway refuses. It also lets a leaked
  operator secret open any account, so it belongs only on a station the operator alone runs. On a phone,
  `tls.sh` sets it, and `tls.sh --disable` removes it before anyone else operates the station.
- **The link names only the hotspot origin.** `--link-origin` accepts `APP_URL`, or `https` at a private IPv4
  address (10/8, 172.16/12, 192.168/16) on `HTTPS_PORT` while that listener runs. The gateway refuses any
  other origin.
- **The session lives on that origin.** The visitor confirms on the hotspot origin and returns there. A page
  from any other origin, including another device on the hotspot, cannot confirm the link.
- **Nothing about trust changes.** A visitor's new account is unverified, logs finds only under the visitor's
  own call, and reaches no tier a signed-in user could not reach before.

## Check that it worked

After **Sign in**, the person sees the map signed in under their call. A link confirmed a second time, or after 15
minutes, is refused as an invalid or expired link; mint a new one.

## Next

- [Callsign verification](callsign-verification.md): the step that lets a signed-in member transmit.
- [Off-grid and LAN](../networks/off-grid.md): run the whole instance without internet.
