# Cloudflare split

**With the helper:** `deploy/aprscaching init cloudflare`, then `init ingest-box` on the RF box.

!!! warning "Advanced: the bill grows with your feed"
    D1 bills every row written. A regional feed fits the included allowance; a large or global APRS-IS filter
    does not. Size it with [Cloudflare D1 costs](../../reference/cloudflare-costs.md) before you deploy, and keep
    the write budget on. [Self-host behind Cloudflare](../networks/cloudflare.md) gives the same edge
    without the per-write cost.

A managed core: the Worker gateway with D1 and R2, and the SPA on Pages, set up by
`deploy/cloudflare/deploy-cf.sh` (or `deploy/aprscaching init cloudflare`, which runs it and records the URLs
for `status` and `doctor`). Nothing of yours runs in the cloud except that; the RF ingest runs on your
own box with `compose.ingest-only.yml` and `INGEST_URL` pointing at the Worker. A cloud VM may add an
APRS-IS-only feed the same way, never the RF bridge. Back it up with D1 Time Travel and a copy of the R2
media — see [Backups](../day-to-day/backups.md#what-to-back-up).

Set the Worker's `APP_URL` to the Pages site. The embeddable map widget (`/embed`) is served by the Worker
but loads MapLibre from the web app's build at `APP_URL`; the build's `_headers` file lets Pages serve that
copy to the Worker's origin.

Cost scales with rows written: [Cloudflare D1 costs](../../reference/cloudflare-costs.md) has the sizing
table and the write budget that caps it.

## With the helper

`init cloudflare` is kept to the existing one-shot (`deploy/cloudflare/deploy-cf.sh`, which needs `wrangler`
logged in). It first says what the split costs and points to Self-host behind a Cloudflare Tunnel, then
asks before it deploys (`--yes` confirms). It records the Worker's and the app's URLs (`--api-base`,
`--app-url`), so `status` and `doctor` work from the same machine afterwards. Set up the RF box with
`init ingest-box --gateway <the Worker's URL>`.

## Next

- [Your first hour](../first-hour.md).
- [Cloudflare D1 costs](../../reference/cloudflare-costs.md).
