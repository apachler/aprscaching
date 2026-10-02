# Cloudflare Tunnel and CDN

**With the helper:** `deploy/aprscaching init selfhost`, choosing the Cloudflare Tunnel.

The way to use Cloudflare. The gateway and its data stay on your box; Cloudflare only carries the traffic.

- **Tunnel** — choose the Cloudflare Tunnel in `setup.sh` (or `deploy/aprscaching init selfhost`). The box
  opens no port and needs no static IP; `compose.home.yml` runs the connector. TLS ends at Cloudflare's edge,
  and `TRUST_CF=1` (which the tunnel overlay sets) keeps the visitor's address for rate limits.
- **CDN** — proxy the hostname through Cloudflare and run `deploy/cloudflare/cache-rules.sh`
  (`CF_API_TOKEN`, `CF_ZONE_ID`) to cache the web app and bypass the API. Without the tunnel, restrict ports 80
  and 443 to Cloudflare's address ranges and set `TRUST_CF=1`.

Both work on Cloudflare's free plan, and neither bills by what the instance writes.

## Set up the tunnel

No port-forwarding, no static IP, CGNAT-friendly — the Pi opens an outbound connection to
Cloudflare and your domain rides it. You need a (free) Cloudflare account with your domain's DNS
on it.

1. **Create the tunnel.** In the Cloudflare dashboard: **Zero Trust → Networks → Tunnels →
   Create a tunnel** → connector type *Cloudflared* → name it (e.g. `aprscaching-pi`). On the
   "Install connector" step, copy the long token from the shown command — that is the
   `TUNNEL_TOKEN`. (Don't run their install command; the compose stack runs the connector.)
2. **Give the token to the stack.** Run `./setup.sh`, choose the Cloudflare Tunnel, and paste the token
   and your hostname: it writes `TUNNEL_TOKEN`, `APP_URL=https://<hostname>` and `DOMAIN=:80` — TLS
   terminates at Cloudflare's edge, so Caddy serves plain HTTP inside the stack and must not try to fetch
   a certificate.
3. **Route your hostname.** Still in the tunnel dialog (or later under **Tunnels → your tunnel →
   Public hostnames**): add e.g. `aprs.example.net`, service type **HTTP**, URL `caddy:80`. The
   connector shares the compose network, so the service name resolves. Cloudflare creates the DNS
   record for you.
4. **Start it.**

    ```bash
    cd deploy
    SOURCE_COMMIT=$(git rev-parse HEAD) docker compose -f docker-compose.yml -f compose.home.yml up -d --build
    ```

5. **Verify.** The tunnel shows *HEALTHY* in the dashboard, `https://aprs.example.net/health`
   answers `ok`, and the SPA loads. Continue with [Your first hour](../first-hour.md).

## Next

- [44Net address](44net.md).
