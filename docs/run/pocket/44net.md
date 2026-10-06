# Reach Pocket from outside

This page shows the sysop how to reach a Pocket station from beyond its hotspot, through a Cloudflare Tunnel or a
44Net address. At the end members open the station by a name of yours, and with 44Net it federates under your
callsign.

## Before you start

- Pocket runs on the phone ([Run Pocket in the field](field-station.md)).
- For the tunnel: a Cloudflare account and a domain on Cloudflare.
- For 44Net: an amateur licence and a 44Net Connect account ([44Net address](../networks/44net.md)).

## Reaching it from the internet

Mobile networks put the phone behind the carrier's NAT: nothing on the internet can open a connection to it.
Without help the station is reachable only on its hotspot and on a Wi-Fi it has joined. Two routes reach it, both
optional and off by default:

| Route | Who reaches the station | Needs a data connection |
|---|---|---|
| Cloudflare Tunnel | anyone, by your hostname | yes |
| WireGuard with 44Net Connect | 44Net hosts, or the whole internet with a full tunnel | yes |

Exposing a field station publicly is your decision.

### Cloudflare Tunnel

1. In the Cloudflare dashboard, create a named tunnel and point its public hostname at `http://localhost:8787`
   ([Set up the tunnel](../networks/cloudflare.md#set-up-the-tunnel)).
2. In Termux, install `cloudflared` and store the tunnel token:

    ```bash
    pkg install cloudflared
    ( umask 077; printf '%s\n' '<the tunnel token>' > ~/.aprscaching/tunnel.token )
    ```

3. Start the tunnel in the station's tmux session:

    ```bash
    tmux new-window -d -t aprscaching -n tunnel 'TUNNEL_TOKEN="$(cat ~/.aprscaching/tunnel.token)" cloudflared tunnel --no-autoupdate run'
    ```

4. Set `APP_URL=https://<your hostname>` in `~/.aprscaching/.env`, then run
   `bash ~/aprscaching/deploy/pocket/restart.sh gateway`.

Passkeys and sign-in links then belong to that hostname, so open the station there on the phone too. A quick
tunnel (`cloudflared tunnel --url …`) gets a new random name on every run and does not fit `APP_URL`.

Leave `TRUST_CF` unset. The hotspot stays a direct way in, where a client could send Cloudflare's client-address
header itself. The rate limits then count every visitor through the tunnel as one client.

## Pocket on 44Net

With [44Net Connect](../networks/44net.md), ARDC's WireGuard service, the phone gets a fixed 44.x address and the
station a callsign-verified name to federate under. Termux cannot run WireGuard without root, so the **WireGuard
app** carries the tunnel for the whole phone.

1. Import the configuration the ARDC portal issues for the phone into the WireGuard app (F-Droid or the Play
   Store).
2. In the app, set the tunnel's MTU to 1420 or less (1412 on PPPoE, 1372 on DS-Lite) and the peer's *Persistent
   keepalive* to 25. Keep `AllowedIPs` as issued. On Pocket, `deploy/aprscaching net44 setup <file>` changes
   nothing on the network: it prints these steps, with the MTU it measures for your path where Termux's `ping`
   can ([Bring the tunnel up](../networks/44net.md#2-bring-the-tunnel-up)), and sets the station's 44Net name
   ([Federate under your callsign](#federate-under-your-callsign)).
3. Turn on *Always-on VPN* for the tunnel in Android's VPN settings, so it comes back after a network change.
   Android runs one VPN at a time.
4. Test inbound from another network: open `http://<44.x address>:8787/health`.

!!! warning "Which traffic takes the tunnel"
    Android routes by the tunnel's `AllowedIPs`, and without root nothing can route by source address. So the
    choice is all or little:

    - **Split tunnel** (`AllowedIPs` covering 44Net only): the rest of the phone's traffic stays on mobile data
      or Wi-Fi, but only 44Net hosts can reach the station on its 44.x address. A reply to anyone else leaves by
      mobile data, from the carrier's address, and never arrives.
    - **Full tunnel** (`AllowedIPs = 0.0.0.0/0`): the station is reachable from the whole internet on its 44.x
      address, and **every** app's traffic runs through ARDC.

    **Unverified:** which `AllowedIPs` the configuration 44Net Connect issues uses, and whether ARDC's policy
    covers a phone's whole traffic in a full tunnel. Check the file you imported and ARDC's terms.

### What answers on the 44.x address

The gateway listens on every interface, the tunnel included, and 44Net Connect filters nothing
([Who can reach you](../networks/44net.md#who-can-reach-you)). Port 8787, and 8443 with https on, answer on the
44.x address. So does anything else running in Termux, such as `sshd` on 8022: stop it (`pkill sshd`) while the
tunnel is up. `status.sh` shows *44Net: up* with this warning, and the station notification shows *44Net: up
(44.x)*.

The hotspot and a MeshCom node stay on the phone's own networks. `status.sh` shows whether the node's listener
still runs.

**Unverified:** whether Android delivers inbound connections on the VPN interface to Termux on every phone.
Also unverified: whether the hotspot and ExtUDP keep working with a full tunnel up on every phone. Test before you rely on it.

### Federate under your callsign

The phone runs under a name of its own beside your home station, by default
`aprscaching-pocket.<call>.ampr.org`; the home station keeps `aprscaching.<call>.ampr.org` and the callsign's
record.

1. Give the phone its own instance name and its own key in the [setup questions](../install/pocket.md#install).
2. Run `deploy/aprscaching net44 setup`: besides the WireGuard app steps, it puts the phone's 44Net name into
   `FED_ENDPOINTS` (`--name` picks another label under your call) and prints the records to add.
3. Add the two records in the 44Net Portal under `<call>.ampr.org`
   ([Several instances under one call](../networks/44net-identity.md#several-instances-under-one-call)):

    | Name in the Portal | Type | Value |
    |---|---|---|
    | `aprscaching-pocket` | A | the phone's 44.x address |
    | `_aprscaching.aprscaching-pocket` | TXT | `v=acs1; inst=<the phone's INSTANCE>; key=<the phone's federation key>`, plus `; host=…; web=https://…` when the phone has a public https `APP_URL` (a Cloudflare Tunnel) |

    **Instance admin → Federation → Publish your callsign identity** on the phone shows both, ready to copy. The
    Portal's name field accepts the dotted name `_aprscaching.aprscaching-pocket` as it stands.

4. Restart the gateway (`bash ~/aprscaching/deploy/pocket/restart.sh gateway`), then choose **Check now** on the
   same page. Peers add the phone by its host, `aprscaching-pocket.<call>.ampr.org`.

Following your home instance works with or without the tunnel
([Your home instance as the hub](trips.md#your-home-instance-as-the-hub)).

### HTTPS on the 44Net name

A browser grants passkeys, location and Web Bluetooth only to https. For members who open the station by its
ampr.org name, `extras/ampr-cert.sh` obtains a Let's Encrypt certificate with a DNS-01 record you add in the ARDC
portal:

```bash
pkg install lego
bash ~/aprscaching/deploy/pocket/extras/ampr-cert.sh --host aprscaching-pocket.<call>.ampr.org --use
```

1. The script prints the `_acme-challenge` TXT record. Add it in the ARDC portal.
2. The script checks DNS every minute until the portal has published it (about once an hour, up to 180 minutes
   with `--wait-min`), then lets lego finish.
3. With `--use` it serves the certificate on the https port.

Running it means accepting the Let's Encrypt Subscriber Agreement. The certificate names only the ampr.org name:
hotspot visitors who open the station by address then see a name warning, and `tls.sh` switches back to the
station certificate. Each renewal repeats the record; `status.sh` warns 14 days before the certificate expires.
The certificate covers the 44Net name only. HAMNET is a separate network: a station that also has a HAMNET
address serves it as plain http, since RF carries no encryption.
[TLS on the 44Net name](../networks/several-addresses.md#get-a-certificate-for-the-44net-name) has the background.

## Check that it worked

- `status.sh` shows *44Net: up* and the 44.x address; `deploy/aprscaching net44 status` and `net44 check` say
  the same. A 44Net address is one in `44.0.0.0/9` or `44.128.0.0/10`; whether the internet reaches it depends
  on how its subnet is routed, and a Connect address is reachable. When `FED_ENDPOINTS` declares a `hamnet`
  endpoint, `status.sh` names it on a line of its own: HAMNET is a separate network, not on the internet.
- From another network, `http://<44.x address>:8787/health` or `https://<your hostname>/health` answers.

## Next

- [Before a trip: sync and your home hub](trips.md): follow your home instance from the field.
