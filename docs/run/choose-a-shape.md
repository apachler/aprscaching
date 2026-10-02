# Choose a shape

This page helps a sysop pick where an instance runs. It compares every shape side by side; at the end you know
which install page to follow.

**The default is Self-host with Docker.** One box you own (a Raspberry Pi, a mini-PC or a VM) runs the gateway,
the RF ingest and TLS. Its cost is flat: SQLite on your own disk costs the same at ten packets a minute as at a
thousand. A large or global APRS-IS filter is no problem. Pick another shape only for one of the reasons in
the table.

## The shapes side by side

| Shape | What runs where | Who it is for | Ingress | Cost | Effort |
|---|---|---|---|---|---|
| [**Self-host with Docker**](install/self-host-docker.md) (recommended) | Gateway, ingest and Caddy in Docker on your box | Clubs and operators who want an always-on instance | Caddy with automatic TLS (ports 80 and 443), a Cloudflare Tunnel, or the LAN only | Flat: your box and its power | A Linux box with Docker; one wizard |
| [**Self-host behind Cloudflare**](networks/cloudflare.md) | The same Docker stack; Cloudflare carries the traffic | A home connection without a static IP or open ports (CGNAT) | Cloudflare Tunnel, optionally Cloudflare's CDN in front | Flat: Cloudflare's free plan does not bill by what the instance writes | Self-host plus a Cloudflare account with your domain |
| [**Self-host without Docker**](install/self-host-bare-metal.md) | Gateway and ingest from a checkout under systemd | Sysops who run their own services without Docker | Your own reverse proxy with TLS, or the LAN only | Flat | Node.js 22 or newer, one helper command, your proxy |
| [**Desktop**](install/desktop.md) | One executable on your computer, the web app inside | Trying it out, a field day, one operator off-grid | None: `127.0.0.1`, or the LAN with `HOST=0.0.0.0` | Free | Download, check, run |
| [**Pocket**](install/pocket.md) | Gateway and ingest on an Android phone in Termux | Field days, demos and hikes; not an always-on server | The phone's hotspot; optionally a Cloudflare Tunnel or 44Net | Free | A phone, Termux, one installer |
| [**Cloudflare split**](install/cloudflare-split.md) (advanced) | Gateway on Cloudflare (Worker, D1, R2, Pages); the ingest on your box | Sysops with no box that can run the gateway | Cloudflare's edge | Grows with your feed: D1 bills every row written | A Cloudflare account, `wrangler`, and an ingest box |
| [**Ingest box only**](radios/ingest-box.md) (a role, not a gateway) | Only the ingest, next to your radio, feeding a gateway elsewhere | The radio side of the Cloudflare split, or a second receiver for any instance | Outbound only, to the gateway's `/ingest` | Flat | Docker on a Pi; one helper command |

Every shape runs the same gateway with the full feature set: Node and SQLite (Self-host, bare metal, Pocket),
Bun and SQLite (Desktop), or a Worker with D1 (Cloudflare split).

## Want Cloudflare?

Run Self-host behind Cloudflare. A Cloudflare Tunnel needs no open port and no static IP, and the CDN can sit in
front. You get Cloudflare's edge TLS, DDoS protection and caching on its free plan. The data stays in SQLite on your
box, so the cost does not grow with your feed.

Choose the Cloudflare split only when no box of yours can run the gateway. There the gateway itself runs on
Cloudflare, D1 bills every row written, and the
[write budget](../reference/cloudflare-costs.md#write-budget) caps the bill by shedding low-value writes.

## Where the radio fits

In every shape the RF ingest runs on your own equipment: the stack's own ingest, or an
[ingest box](radios/ingest-box.md) next to the radio. The browser can also bridge a USB or Bluetooth radio with
no server at all. A cloud VM may add an APRS-IS-only feed, never the RF bridge.

You can change your mind later: a backup from one shape restores into another
([Moving between shapes](day-to-day/backups.md#moving-between-shapes)).

## Next

- [Self-host with Docker](install/self-host-docker.md): install the recommended shape.
- [Check a download](install/verified-downloads.md): how every release file is checked before you run it.
