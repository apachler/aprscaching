# Choose a shape

An instance runs in one of a few shapes. This page compares them and recommends one.

- **Self-host** — the recommended default. The Docker stack on a Pi, a mini-PC or a VM runs the gateway, the
  RF ingest and TLS on one box you own. Its cost is flat: SQLite on your own disk costs the same at ten
  packets a minute as at a thousand, so a large or global APRS-IS filter is no problem. It also matches the
  project's rule that the RF ingest runs on the operator's own equipment — here the ingest sits right next to
  the gateway.
- **Desktop** — one executable, no Docker. Pick it to try the platform out, for a field day, or for a
  single operator off-grid.
- **On a phone** — [Pocket](install/pocket.md) runs the Self-host gateway and ingest on an Android phone in Termux:
  a field-day and demo station with its own hotspot and a MeshCom node, not an always-on server.
- **Want Cloudflare?** Run [Self-host behind Cloudflare](networks/cloudflare.md): a Cloudflare Tunnel
  (no open ports, no static IP) and optionally its CDN in front of your own box. You get Cloudflare's edge TLS,
  DDoS protection and caching on its free plan, and the data stays in SQLite on your box, so the cost does not
  grow with your feed.
- **Cloudflare split** *(advanced)* — the gateway itself runs on Cloudflare (Worker, D1, R2), and your own
  box runs only the RF ingest. D1 bills every row written, so the cost grows with your feed; the
  [write budget](../reference/cloudflare-costs.md#write-budget) caps it by shedding low-value writes. Choose
  it only when no box of yours can run the gateway.

## The shapes side by side

| Shape | Gateway | Ingress | Operator-local ingest | Walkthrough |
|-------|---------|---------|-----------------------|-------------|
| [**Self-host**](install/self-host-docker.md) (recommended) | Node + SQLite in the Docker stack | Caddy with automatic TLS, or a Cloudflare Tunnel; optionally Cloudflare's CDN in front | the stack's own `ingest` service, or `compose.ingest-only.yml` on the radio box | [Self-host with Docker](install/self-host-docker.md) |
| [**Desktop**](install/desktop.md) | Bun single binary | none — `127.0.0.1`, or the LAN with `HOST=0.0.0.0` | the browser RF bridge, or `apps/ingest` beside it | `deploy/desktop/README.md` |
| [**Cloudflare split**](install/cloudflare-split.md) (advanced) | Worker + D1 + R2, SPA on Pages | Cloudflare's edge | `compose.ingest-only.yml` on your own box | `deploy/README.md` |

In every shape the RF ingest runs on your own equipment (`compose.ingest-only.yml` points it at any
gateway), and the browser can bridge a USB or Bluetooth radio with no server at all.

## Next

- [Self-host with Docker](install/self-host-docker.md): the recommended shape.
