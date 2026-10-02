# Reach Pocket from outside

A phone on a hotspot is hard to reach. This page reaches it through Cloudflare or a 44Net address.

## Reaching it from the internet

Mobile networks put the phone behind the carrier's NAT: without help, the station is reachable only on its
hotspot and on a Wi-Fi it has joined. Two optional routes, both off by default:

- **Cloudflare Tunnel** — `pkg install cloudflared`, a named tunnel from the Cloudflare dashboard with its
  public hostname pointing at `http://localhost:8787`, and `APP_URL=https://<your hostname>` in the `.env`.
  Leave `TRUST_CF` unset: the hotspot stays a direct way in.
- **WireGuard and 44Net Connect** — the WireGuard app carries a fixed 44.x address for the whole phone, and
  the gateway answers on it; see [Pocket on 44Net](#pocket-on-44net).

The [README](https://github.com/apachler/aprscaching/blob/dev/deploy/pocket/README.md#reaching-the-station-from-the-internet)
has the commands.

## Pocket on 44Net

With [44Net Connect](../networks/44net.md), ARDC's WireGuard service, the phone gets a fixed 44.x address, and the
station a callsign-verified name to federate under. Termux cannot run WireGuard without root, so the
**WireGuard app** carries the tunnel for the whole phone: import the configuration the ARDC portal issues
for the phone, and turn on *Always-on VPN* for it in Android's VPN settings so the tunnel comes back after
a network change. Android runs one VPN at a time. In the app, set the tunnel's MTU to 1420 or less (1412 on
PPPoE, lower on DS-Lite) and the peer's *Persistent keepalive* to 25; `deploy/aprscaching net44 setup <file>` in
Termux prints the MTU it measures for your path, where Termux's `ping` can ([Bring the tunnel up](../networks/44net.md#2-bring-the-tunnel-up)).

!!! warning "Which traffic takes the tunnel"
    Android routes by the tunnel's `AllowedIPs`, and without root nothing can route by source address. So
    the choice is all or little:

    - **Split tunnel** (`AllowedIPs` covering 44Net only): the rest of the phone's traffic stays on mobile
      data or Wi-Fi, but only 44Net hosts can reach the station on its 44.x address. A reply to anyone else
      leaves by mobile data, from the carrier's address, and never arrives.
    - **Full tunnel** (`AllowedIPs = 0.0.0.0/0`): the station is reachable from the whole internet on its
      44.x address, and **every** app's traffic runs through ARDC.

    **Unverified:** which `AllowedIPs` the configuration 44Net Connect issues uses, and whether ARDC's
    policy covers a phone's whole traffic in a full tunnel; check the file you imported and ARDC's terms.

- **Test inbound.** **Unverified:** whether Android delivers inbound connections on the VPN interface to
  Termux on every phone. Open `http://<44.x address>:8787/health` from another network before you rely on it.
- **Exposure.** The gateway listens on every interface, the tunnel included, and 44Net Connect filters
  nothing ([Who can reach you](../networks/44net.md#6-who-can-reach-you)): port 8787, and 8443 with https on, answer on
  the 44.x address. So does anything else running in Termux, such as `sshd` on 8022; stop it (`pkill sshd`)
  while the tunnel is up. `status.sh` shows *44Net: up* with this warning, and the station notification shows
  *44Net: up (44.x)*.
- **The hotspot and a MeshCom node** stay on the phone's own networks. **Unverified:** that the hotspot and
  ExtUDP keep working with a full tunnel up on every phone; `status.sh` shows whether the node's listener
  still runs.
- **Federation.** Publish the `_aprscaching` TXT record (the phone's own, under its host, when your home
  station already uses the callsign's) and add the 44net endpoint to `FED_ENDPOINTS` as in
  [44Net steps 3 and 4](../networks/44net-identity.md#3-name-and-identity), then run the self-check under **Instance admin →
  Setup → 44Net**. The phone needs its own instance name (the [setup questions](../install/pocket.md#install)) and its own key;
  following your home instance works with or without the tunnel ([Your home instance as the hub](trips.md#your-home-instance-as-the-hub)).
- **https on the 44Net name.** A browser grants passkeys and location only to https. For members who open
  the station by its ampr.org name, `extras/ampr-cert.sh` obtains a Let's Encrypt certificate with a
  DNS-01 record you add in the ARDC portal:

    ```bash
    pkg install lego
    bash ~/aprscaching/deploy/pocket/extras/ampr-cert.sh --host <call>.ampr.org --use
    ```

    It prints the `_acme-challenge` TXT record to add, checks DNS every minute until the portal has
    published it (about once an hour), lets lego finish, and with `--use` serves the certificate on the
    https port. That certificate names only the ampr.org name: hotspot visitors who open the station by
    address then see a name warning, and `tls.sh` switches back to the station certificate. Each renewal
    repeats the record; `status.sh` warns 14 days before the certificate expires.
    [TLS on the 44Net name](../networks/44net-identity.md#tls-on-the-44net-name) has the background.

## Next

- [Before a trip: sync and your home hub](trips.md).
