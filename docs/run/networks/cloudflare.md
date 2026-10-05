# Put Cloudflare in front

This page puts a Self-host instance behind Cloudflare, with a tunnel, the CDN, or both. It is for the sysop;
at the end visitors reach the instance under your domain, while the gateway and its data stay on your box.

This is the recommended way to use Cloudflare: Cloudflare only carries the traffic. Both parts work on
Cloudflare's free plan, and neither bills by what the instance writes.

- **Tunnel**: the box opens no port and needs no static address. It opens an outbound connection to
  Cloudflare, and your domain rides it, behind CGNAT too. TLS ends at Cloudflare's edge.
- **CDN**: Cloudflare caches the web app and passes the API through.

## Before you start

- A free Cloudflare account with your domain's DNS on it.
- The Self-host stack in a checkout of the repository ([Self-host with Docker](../install/self-host-docker.md)).

## Set up the tunnel

1. **Create the tunnel.** In the Cloudflare dashboard, open **Zero Trust → Networks → Tunnels →
   Create a tunnel**, choose the connector type *Cloudflared* and name it, for example `aprscaching-pi`.
   On the "Install connector" step, copy the long token from the command shown: that is the `TUNNEL_TOKEN`.
   Don't run Cloudflare's install command; the compose stack runs the connector.
2. **Give the token to the stack.** In `deploy/`, run `./setup.sh` and choose the Cloudflare Tunnel, then
   paste the token and your hostname. `deploy/aprscaching init selfhost` asks the same. It writes
   `TUNNEL_TOKEN`, `APP_URL=https://<hostname>` and `DOMAIN=:80`: TLS ends at Cloudflare's edge, so Caddy
   serves plain http inside the stack and must not try to fetch a certificate.
3. **Route your hostname.** In the tunnel dialog, or later under **Tunnels → your tunnel → Public
   hostnames**, add your hostname (for example `aprs.example.net`), service type **HTTP**, URL `caddy:80`.
   The connector shares the compose network, so the service name resolves. Cloudflare creates the DNS record.
4. **Start it.** In `deploy/`:

    ```bash
    SOURCE_COMMIT=$(git rev-parse HEAD) docker compose -f docker-compose.yml -f compose.home.yml up -d --build
    ```

    `compose.home.yml` runs the connector, publishes no ports on Caddy, and sets `TRUST_CF=1` on the
    gateway ([Visitor addresses](#visitor-addresses)). It removes Caddy's ports with `!reset`, which needs
    Docker Compose 2.24 or newer; `deploy/aprscaching doctor` fails `service.tunnel_ports` when Caddy still
    publishes them.

## Put the CDN in front

1. **Proxy your hostname's DNS record.** In the Cloudflare dashboard, open your domain, then **DNS → Records**.

    - **With the tunnel**, the record already exists: the tunnel created a `CNAME` for your hostname that points
      at `<tunnel id>.cfargotunnel.com`, and it is always proxied. Check that its **Proxy status** shows
      **Proxied** and go on to step 2.
    - **Without the tunnel**, add the record yourself, or edit the one you have: type **A** (and **AAAA** if the
      box has a public IPv6 address), name your hostname (for example `aprs` for `aprs.example.net`), content
      the box's public address, and switch **Proxy status** to **Proxied**, the orange cloud. **DNS only**, the
      grey cloud, sends visitors straight to the box and bypasses the CDN.

    Without the tunnel, Caddy keeps its own certificate, so set **SSL/TLS → Overview → Encryption mode** to
    **Full (strict)**: Cloudflare then reaches the box over https and checks Caddy's certificate. Leave **SSL/TLS →
    Edge Certificates → Always Use HTTPS** off; Caddy redirects to https itself, and Let's Encrypt's renewal
    requests on plain http must reach Caddy. If Caddy has no certificate yet, start the stack while the record
    is still **DNS only**, wait until `https://<hostname>` answers, then switch the record to **Proxied**.

    **Check it:** `dig +short <hostname>` answers with Cloudflare's addresses, not the box's, and
    `curl -sI https://<hostname>/` shows `server: cloudflare`.

2. Create an API token that can edit the zone's cache rules, and note the zone's ID.
3. In the repository's top directory, write the cache rules:

    ```bash
    CF_API_TOKEN=<token> CF_ZONE_ID=<zone id> deploy/cloudflare/cache-rules.sh
    ```

    | Paths | Rule |
    |---|---|
    | `/api`, `/auth`, `/ws`, `/ingest`, `/outbox`, `/federation`, `/.well-known`, `/source` | never cached |
    | `/assets/` (the build's content-hashed files) and files ending in `.woff2`, `.pmtiles` | cached at the edge for one day |
    | `/`, files ending in `.html`, `/sw.js` and the web manifest | never cached, so a new release reaches every visitor at once |

4. Without the tunnel, let only Cloudflare reach the box: restrict ports 80 and 443 to
   [Cloudflare's address ranges](https://www.cloudflare.com/ips/), and set `TRUST_CF=1` in `deploy/.env`.

## Visitor addresses

The gateway rate-limits by the visitor's address. Behind Cloudflare, every request comes from Cloudflare,
which names the visitor in the `cf-connecting-ip` header. With `TRUST_CF=1` the gateway keeps that header;
without it, the gateway drops it, so a client that reaches the box directly cannot pick a new identity on
every request. Set `TRUST_CF=1` only when Cloudflare is the only way in: the tunnel, or proxied DNS with
ports 80 and 443 limited to Cloudflare.

## Check that it worked

- The tunnel shows *HEALTHY* in the Cloudflare dashboard.
- `curl -fsS https://aprs.example.net/health` answers `{"ok":true,…}`, and the web app loads.
- After the cache rules, a second request for a `.js` file shows `cf-cache-status: HIT` in its response
  headers ([Cloudflare's cache responses](https://developers.cloudflare.com/cache/concepts/cache-responses/)).

## Next

- [Your first hour](../first-hour.md): what to do once the instance answers.
- [44Net address](44net.md): a static amateur-radio address for the same box.
