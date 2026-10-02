# Cloudflare split

This page deploys the gateway on Cloudflare (a Worker with D1 and R2, the web app on Pages) and the RF ingest on
a box of your own. It is for a sysop with no box that can run the gateway; at the end the Worker answers and
your ingest box feeds it.

!!! warning "Advanced: the bill grows with your feed"
    D1 bills every row written. A regional feed fits the included allowance; a large or global APRS-IS filter
    does not. Size it with [Cloudflare D1 costs](../../reference/cloudflare-costs.md) before you deploy, and keep
    the write budget on. [Self-host behind Cloudflare](../networks/cloudflare.md) gives the same edge without
    the per-write cost.

Only the gateway and the web app run in the cloud. The RF ingest runs on your own box and posts to the Worker. A
cloud VM may add an APRS-IS-only feed the same way, never the RF bridge.

## Before you start

- **A Cloudflare account**, with your domain on it if the Worker and the app get custom names.
- **`wrangler`**, installed (`npm i -g wrangler`) and signed in (`wrangler login`).
- **A clone of the repository**, with its dependencies installed (`pnpm install`): the deploy builds the web app.
- **The two public URLs**: the Worker's (for example `https://api.example.net` or
  `https://aprscaching.<you>.workers.dev`) and the app's on Pages (for example `https://aprs.example.net`).
- **A box next to your radio** with Docker, for the [ingest box](../radios/ingest-box.md).

## Steps

1. Deploy, from the root of the clone:

    ```bash
    deploy/aprscaching init cloudflare --api-base https://api.example.net --app-url https://aprs.example.net
    ```

    It states the cost and points to Self-host behind a Cloudflare Tunnel, then asks before it deploys
    (`--yes` confirms). It runs `deploy/cloudflare/deploy-cf.sh` and records both URLs, so `status` and `doctor`
    work from this machine afterwards. The script alone does the same without the record.

2. Answer the script. It:

    1. creates the D1 database `aprscaching` and waits while you paste its `database_id` into
       `workers/gateway/wrangler.toml`. While it waits, also set `APP_URL` under `[vars]` to the app's URL.
       The embeddable map widget (`/embed`) is served by the Worker but loads MapLibre from the app at
       `APP_URL`; the app's `_headers` file lets Pages serve that copy to the Worker's origin;
    2. creates the R2 bucket `aprscaching-media`;
    3. asks for `INGEST_SECRET`, `OPERATOR_SECRET` and `SESSION_SECRET` (`wrangler secret put`). Give three
       different values, each from `openssl rand -hex 32`;
    4. applies the migrations to D1, deploys the Worker stamped with its source commit, builds the web app
       against the Worker's URL and deploys it to Pages.

3. Connect your RF box. Create a one-time code under **Instance admin → Ingest boxes**, then, on the box:

    ```bash
    deploy/aprscaching init ingest-box --gateway https://api.example.net
    ```

    [Set up an ingest box](../radios/ingest-box.md) covers the box, its radios and the alternative with the
    shared `INGEST_SECRET`.

## Check that it worked

```bash
curl -fsS https://api.example.net/health
OPERATOR_SECRET=<the operator secret> deploy/aprscaching doctor
```

`doctor` checks the Worker over the internet, reads the Setup checklist (with the D1 write budget) when
`OPERATOR_SECRET` is set, and checks that the Pages app talks to this Worker.

D1 Time Travel keeps the database restorable; the R2 media needs its own copy
([Backups](../day-to-day/backups.md#what-to-back-up)).

## Next

- [Your first hour](../first-hour.md): sign in, confirm your call and make the instance public-ready.
- [Cloudflare D1 costs](../../reference/cloudflare-costs.md): the sizing table and the write budget.
