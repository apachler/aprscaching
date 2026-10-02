# 44Net address

**44Net** (AMPRNet) is the amateur-radio IPv4 space `44.0.0.0/8`, administered by
[ARDC](https://www.ardc.net/). For an aprscaching instance it gives two things:

- **Reachability.** *44Net Connect* gives one machine a static 44.x address over a WireGuard tunnel, so
  the box is reachable without port forwarding — behind CGNAT, on a mobile or satellite link, or on a
  home line with a changing address.
- **Identity.** ARDC issues `<call>.ampr.org` only after checking the operator's licence, so a record
  published under that name binds a federation key to a verified callsign.

It adds no **trust**. A 44.x source address, the WireGuard tunnel and a HAMNET path are transports;
authenticity comes only from signatures and pinned keys, and a peer's trust tier stays the operator's
decision ([transport is not trust](../../reference/trust-model.md#transport-is-not-trust)). The RF ingest stays on your
own equipment: 44Net reaches that equipment, it is never a reason to move the ingest anywhere else.

This page is a recipe for the [Self-host](../install/self-host-docker.md) shape. Statements about ARDC's
services link the ARDC page they come from, checked on 2026-09-30 (the full list is under
[Sources](#sources)); anything those pages do not settle is marked **Unverified**, with what would
settle it.

## 7. What 44Net does and doesn't give you

!!! note "What 44Net does and doesn't give you"
    - **It gives** a static address reachable without port forwarding, and a callsign-verified name to
      publish your federation key under.
    - **WireGuard encrypts only the leg to ARDC.** Between peers, 44Net traffic is plain http. Anything that
      crosses amateur RF — a HAMNET radio link, a packet channel — is signed, never encrypted, under your
      national amateur rules ([compliance](../../shack/on-air.md#no-encryption-on-the-air-sign-never-conceal)).
      No ARDC statement on encryption over its tunnels versus RF was found.
    - **Authenticity comes from signatures,** not from the path: every record is signed, and corroboration
      questions and answers are signed and bound to each other, so a middlebox on a plain-http link can
      neither forge nor replay them ([Cross-instance corroboration](../../reference/federation-trust.md#cross-instance-corroboration)).
    - **A 44.x address proves nothing** about any single packet. A source address is not a signature, so
      aprscaching never derives identity or trust from one.
    - **A verified name is identity, not trust.** A peer added by callsign is recorded as
      `verified_via = 'ardc-lot'` and enters `unvetted`, like any discovered peer. Whether its records and
      corroboration count is your decision under **Instance admin → Federation**.

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

On a Self-host or bare-metal box, let the helper do it. Copy the configuration Connect issued to the box, then:

```bash
sudo deploy/aprscaching net44 setup wg44.conf --name aprscaching.<call>.ampr.org
deploy/aprscaching net44 status
```

It installs the tunnel as `wg44` (`/etc/wireguard/wg44.conf`, owner-only; the issued file is kept beside it) and
changes four things about the issued configuration:

- **The MTU.** It probes the path to the endpoint and sets the tunnel's MTU to that path less 80 bytes, at most
  1420. wg-quick otherwise derives it from the interface's MTU, which is too large wherever the path carries less
  than the interface does: a cloud VM with a 9000-byte MTU behind a 1500-byte gateway, PPPoE (1492), DS-Lite
  (1452). Too large an MTU looks like a tunnel where small requests work and large replies hang. Override it
  with `--mtu`.
- **Keepalive.** It adds `PersistentKeepalive = 25` to the peer when the configuration has none, so NAT and CGNAT
  keep the tunnel open for traffic that comes in.
- **Full or split tunnel.** A configuration whose `AllowedIPs` covers everything (`0.0.0.0/0`) would send all the
  box's traffic through ARDC and cut the SSH session that brought it up. The helper turns such a tunnel into
  policy routing (`Table = off`): only traffic from the 44.x address, and replies to connections that came in
  on the tunnel, take it; everything else stays on the internet link. A split configuration (`AllowedIPs`
  covering 44Net only) stays as issued — it carries 44Net traffic only, so hosts outside 44/8 cannot reach the
  44.x address. For reachability from the whole internet, use a full-tunnel configuration.
- **A firewall** on `wg44` ([step 6](#6-who-can-reach-you)).

It starts the tunnel with a rollback scheduled. Open a new SSH session while it waits and answer `y` once it
connects; without an answer, or when no handshake arrives in a non-interactive run, the tunnel goes down again
and is not started at boot. `--name` adds the 44Net name to `FED_ENDPOINTS` ([step 4](44net-identity.md#4-configure-the-instance)).
`deploy/aprscaching init selfhost --net44-config wg44.conf` (and `init baremetal`) runs the same setup after the
install. `net44 check` checks the DNS records of step 3, `net44 remove` takes it all down again, and `doctor`
checks the tunnel, its MTU and firewall, the records and the certificate.

On Pocket and Desktop a WireGuard app carries the tunnel; `deploy/aprscaching net44 setup wg44.conf` there prints
the settings to enter in the app (the MTU from the same probe, keepalive 25).

**By hand**, install a standard WireGuard client and load the configuration (`wg-quick up <name>` on Linux; the
interface takes the configuration file's name), with the same three changes: an explicit `MTU`, a keepalive, and
for a full tunnel `Table = off` plus a rule for the 44.x source. ARDC's
[Quick Start](https://wiki.ampr.org/wiki/44Net_Connect/Quick_Start) covers the clients and routers it
supports; a community guide from AllStarLink
([44Net Connect](https://allstarlink.github.io/adv-topics/44net-connect/)) shows one Linux install.

Check that the address is up: `ip addr show wg44` lists your 44.x address.

WireGuard encrypts the leg between your machine and ARDC's Connect endpoint, which runs over the
internet. Beyond that endpoint, and on any amateur radio link, the traffic is plain.

A licensed operator can also give the box a static 44.x address over a 44Net Connect WireGuard tunnel —
reachable without port forwarding, even behind CGNAT — and publish its federation identity under
`<call>.ampr.org`: see [44Net address](44net.md). By shape:

| Shape | 44Net |
|---|---|
| Self-host, OCI stack | `deploy/aprscaching net44 setup` brings the tunnel up on the host, with its routing and firewall |
| Bare metal | the same |
| Pocket | the WireGuard app carries it; `net44 setup` prints the app's settings ([Pocket on 44Net](../pocket/44net.md#pocket-on-44net)) |
| Desktop | the WireGuard app carries it; `net44 setup` prints the app's settings |
| Cloudflare split, ingest box | not applicable: the gateway runs at Cloudflare, or elsewhere |

## With the helper

```bash
sudo deploy/aprscaching net44 setup wg44.conf --name aprscaching.<call>.ampr.org   # bring the tunnel up
deploy/aprscaching net44 status        # interface, address, handshake, transfer, MTU, routing, firewall
deploy/aprscaching net44 check         # the A and _aprscaching records of the 44Net name, and how to test from outside
sudo deploy/aprscaching net44 remove   # down, not at boot, firewall and configuration removed, FED_ENDPOINTS cleaned
```

`setup` takes the WireGuard configuration 44Net Connect issued. It writes the tunnel as `wg44` with an MTU
probed from the path, keepalive 25, policy routing for a full tunnel (so SSH stays on the internet link) and a
firewall that lets only TCP 80/443 in. It starts the tunnel under a two-minute rollback that you cancel by
confirming a new SSH session connects. Running it again with the same configuration changes nothing.
`--mtu`, `--no-firewall` and `--name` adjust it; [Bring the tunnel up](#2-bring-the-tunnel-up) explains
each change. `init selfhost` and `init baremetal` take `--net44-config <file>` to run it after the install, and
ask for one when they can.

## 6. Who can reach you

**A 44Net Connect address is reachable from the whole internet, and ARDC filters nothing.** ARDC's Quick
Start: "Your device is now reachable on the Internet at its 44Net IP address"; Firewalling Basics: 44Net
Connect "does not inspect, filter, or block any traffic directed towards 44Net devices"
([Quick Start](https://wiki.ampr.org/wiki/44Net_Connect/Quick_Start),
[Firewalling Basics](https://wiki.ampr.org/wiki/Firewalling_Basics)). The addresses are announced from
ARDC's own network ([Guide for ISPs](https://wiki.ampr.org/wiki/Guide_for_ISPs)). Scanners find a new
address quickly, so the firewall on the tunnel is yours to set:

- Allow only what Caddy serves — TCP 80 and 443 — on the tunnel interface, plus replies to connections
  the box opens, and drop everything else arriving on it. `net44 setup` does this for you, in the tunnel's own
  `PostUp`/`PreDown` so it comes and goes with the tunnel (`--no-firewall` leaves it out). It tells you when ufw
  or firewalld also filter the host; those stay yours to open. By hand, with nftables, for a tunnel named `wg44`:

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
  `net44 setup` adds the same filter to Docker's `DOCKER-USER` chain on a Self-host box. The stack publishes
  only Caddy's 80 and 443; bind any other port you publish (a MeshCom or AXUDP
  listener) to a specific LAN or tunnel address, never to all addresses.
- Never expose SSH, the gateway's port 8080 or an ingest port on the tunnel.

**Test inbound from outside.** Take a phone, turn Wi-Fi off, and open
`http://aprscaching.<call>.ampr.org/health` over mobile data (or `curl -fsS` it from a machine on another
network). Outbound traffic working proves nothing about inbound. That a Connect address is reachable from
a phone on mobile data is what ARDC's documentation states (verified against the pages above); if the test
fails while the tunnel is up:

- your own firewall or router is blocking inbound traffic, and the box is reachable only outbound — it
  can still pull from peers and push to a hub ([Reaching firewalled peers](../federation/hubs-and-relays.md#reaching-firewalled-peers));
- or replies leave by the wrong route: a tunnel that carries only 44Net traffic (a "split tunnel",
  [Single Device Tunnel](https://wiki.ampr.org/wiki/44Net_Connect/Single_Device_Tunnel)) must still send
  replies from the 44.x address back through the tunnel, and WireGuard drops a reply to an address outside the
  peer's `AllowedIPs`. A split tunnel therefore serves 44Net hosts only; use a full-tunnel configuration through
  `net44 setup`, which routes replies back through the tunnel and leaves the rest of the box's traffic alone.
  `ip route get <phone's address> from 44.x.y.z` on the box shows which way a reply goes.

**HAMNET.** HAMNET is a separate amateur IP backbone, mostly `44.128.0.0/10` and not announced to the
internet. ARDC: "A subnet reachable via Connect is not automatically part of the Mesh. A Mesh network does
not automatically appear via BGP." ([Decentralization](https://wiki.ampr.org/wiki/Decentralization)).
Whether a HAMNET station can reach a Connect address, and the other way round, is **Unverified**; it
depends on the regional HAMNET gateway, and a test from a HAMNET station settles it for your region.

## AXUDP and AXIP peering over 44Net

Two packet nodes that each have a 44Net Connect address can link directly, even when both sit behind
CGNAT: a Connect address is reachable from the internet with no port forwarding (see
[Who can reach you](#6-who-can-reach-you)). Name the other node by its 44.x address or its
`ampr.org` name:

```bash
AXUDP_PORT=10093
AXUDP_BIND=44.x.y.z                       # listen on the tunnel address only (ingest on the host)
AXUDP_PEERS=oe8xyz.ampr.org:10093         # or 44.a.b.c:10093; several peers comma-separated
# AXIP instead (raw IP protocol 93, needs raw-socket + CAP_NET_RAW):
# AXIP_PEERS=oe8xyz.ampr.org
```

- **Peer enforcement.** With `AXUDP_PEERS` (or `AXIP_PEERS`) set, the port accepts frames only from the
  peers' IPv4 addresses and drops and counts everything else. Names are re-resolved every five minutes, so
  a peer that moves to a new address is followed once its A record changes — within about an hour of the
  change in the ARDC Portal, plus the old record's TTL.
- **Binding.** `AXUDP_BIND` to the 44.x address needs the tunnel up before the ingest starts; a bind to an
  absent address fails and is not retried. In the Docker stack the container does not hold the 44.x
  address: leave `AXUDP_BIND` unset and publish the ingest's UDP port on the tunnel address only
  (`ports: ["44.x.y.z:10093:10093/udp"]`), never on all addresses.
- **Firewall.** Allow the AXUDP port (UDP 10093 by default) on the tunnel interface only from your peers'
  addresses.
- **Frames stay Tier C.** A frame that arrived over AXUDP or AXIP is tunnelled, not heard: it is never
  first-party attested and never reaches Tier A, whatever address it came from.
- **Signed, never encrypted.** WireGuard encrypts only each node's leg to ARDC; the AX.25 frames themselves
  stay plain, and whatever your node puts on the air follows the
  [no-encryption rule](../../shack/on-air.md#no-encryption-on-the-air-sign-never-conceal).
- **Unverified:** whether IP protocol 93 (AXIP) passes between two Connect addresses. ARDC states that
  Connect does not filter traffic, which suggests it does, but no test is recorded; AXUDP rides plain UDP and
  is the safer choice.

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

## Next

- [44Net name and identity](44net-identity.md).
