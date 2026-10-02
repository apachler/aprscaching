# Set up an ingest box

The ingest box carries real radio into an instance. This page sets one up, on the gateway's machine or on a
separate box next to the radio.

## The box

Radio traffic reaches an instance through the **ingest box** — a small program on a Raspberry Pi or PC next
to your radio. It sends what it hears to the instance's gateway, which can be on the same machine, on your
LAN, or in the cloud.

- **Docker** (the usual way): the full stack already contains the ingest box. To run only the ingest box and
  feed a remote instance, use `deploy/compose.ingest-only.yml`. Settings go in `deploy/.env`; apply them with
  `docker compose up -d`. See [Self-host with Docker](../install/self-host-docker.md).
- **From a checkout**: settings go in `.env` at the top of the repository (copy `.env.example`); start it
  with `pnpm --filter @aprscaching/ingest start`.

Two settings are always needed:

```
INGEST_URL=http://127.0.0.1:8787/ingest
INGEST_SECRET=…
```

`INGEST_URL` is the gateway's `/ingest` address; `INGEST_SECRET` must be the same secret the gateway has.
It is the only gateway secret the box needs — never put the gateway's `OPERATOR_SECRET` or `SESSION_SECRET`
on it.

**How you know it works.** The box logs a line per link (shown in each section below). It is silent while
forwarding succeeds and logs `[forward] gateway unreachable …` when it can't reach the gateway. On the
instance, `https://<instance>/api/ports` counts received packets per link over the last 24 hours, and the map
shows the stations under **Search & filter → Live layers → Live stations**.

!!! note "Docker and your radio"
    Inside a container, `localhost` is the container itself. Point the settings at your host's LAN address
    (e.g. `KISS_TNC_HOST=192.168.1.20`), and publish UDP ports for links that receive UDP (MeshCom and
    AXUDP) — see [From a container](rf-ingest.md#from-a-container).

## With the helper

```bash
deploy/aprscaching init ingest-box --gateway https://aprs.example.net --code ABCD-EFGH-JKLM-NPQR --call OE8APR
```

Sets up a box that feeds a gateway elsewhere, in Docker (`compose.ingest-only.yml`):

1. checks that the gateway answers at `<gateway>/ingest/check`;
2. **enrolls the box** with a one-time code from the gateway's **Instance admin → Ingest boxes**
   ([Enrolling ingest boxes](#enrolling-boxes-on-the-gateway)). Enrollment runs inside the ingest
   image, so the box needs no Node.js, and writes `BOX_ID` and `BOX_KEY` into `deploy/.env` without showing
   the key. With `--shared-secret` it takes the gateway's `INGEST_SECRET` instead, asked for without
   echoing it (non-interactive: from the environment);
3. asks for the APRS-IS login and filter, a KISS TNC (`--kiss host[:port]`) and a MeshCom node
   (`--meshcom address=CALL`). With a TNC, it asks for the receiving site the TNC names (`RF_SITE_CALL`),
   which counts for Tier A only once the gateway's sysop lists it in `FIRST_PARTY_SITES`;
4. starts the ingest container and runs `doctor`, which checks the box's credential the way the box sends it:
   signed, for an enrolled box.

It refuses a `deploy/.env` that belongs to a gateway: the Self-host stack runs its own ingest. Re-running it
keeps the enrolled key unless you pass a new `--code`. `--no-start` writes the settings only. A revoked box
shows in `doctor` as refused, with the fix: enroll again with a new code.

## The operator RF box for a remote gateway

In the [Cloudflare split](../install/cloudflare-split.md) — or beside any gateway on another host — only the
ingest runs locally (the RF ingest is always operator-local):

```bash
INGEST_URL=https://api.your.host/ingest docker compose -f compose.ingest-only.yml up -d --build
```

The same stack doubles as a **cloud APRS-IS feed**: on any VM (e.g. OCI), set only the `APRSIS_*`
variables and point `INGEST_URL` at the instance — a baseline global feed from day one. Keep such a
box IS-only: RF transports always belong on the operator's own equipment.

## Enrolling the box

A box reaches its gateway with either the gateway's shared `INGEST_SECRET` or its own key. To get a key, ask
the gateway's sysop for a one-time enrollment code ([Enrolling ingest boxes](#enrolling-boxes-on-the-gateway)).
`deploy/aprscaching init ingest-box` enrolls a Docker box with it ([With the helper](#with-the-helper)).
Without the helper, with `INGEST_URL` set:

```bash
cd apps/ingest
node --import tsx src/enroll.ts --code ABCD-EFGH-JKLM-NPQR [--box shack-1] [--label "home TNC"] >> ../../.env
```

It generates the box's Ed25519 key, registers the public half with the code and appends `BOX_ID` and
`BOX_KEY` to the settings. `BOX_KEY` is the private key: keep it in the settings file, owner-only, and never
on a screen. From then on the box signs its requests and needs no `INGEST_SECRET`. `GET /ingest/check`
answers whether the gateway accepts the box's credential.

## Enrolling boxes on the gateway

Instead of copying `INGEST_SECRET` to a box, you can enroll it. The box then holds its own Ed25519 key and
signs every request to the gateway with it. Revoking that box cuts it off alone; boxes on the shared secret
keep working beside enrolled ones.

1. Create a one-time code in **Instance admin → Ingest boxes** (or `POST /api/admin/boxes/codes`, as the sysop
   or with `OPERATOR_SECRET`). It is shown once, holds 80 random bits, expires after 15 minutes (`ttlMin`, 10–15) and works for one box. Give it
   a `label`, and optionally a `callsign`: a box enrolled for a callsign names only receiving sites of that base
   call.
2. On the box, run `deploy/aprscaching init ingest-box` and enter the code ([With the helper](#with-the-helper);
   without the helper, see [RF ingest](#enrolling-the-box)). It writes `BOX_ID` and `BOX_KEY` into
   the box's settings, which replace `INGEST_SECRET` there.
3. The box appears in the list under **Ingest boxes**, with when it was enrolled and last seen. When you
   created the code signed in, you own the box for [remote control](remote-box.md) without a
   separate pairing step.
4. **Revoke** a box there (or `POST /api/admin/boxes/<id>/revoke`). Its key stops working at once; it comes back only
   with a fresh code and key.

A signed request is fresh for five minutes and accepted once, and a box's key acts only for its own box id.
Enrolling grants nothing beyond the ingest plane: what a box hears counts for Tier A only when you list its
receiving site in `FIRST_PARTY_SITES`, exactly as for a box on the shared secret. The code and box records,
with who created, enrolled and revoked each, are the enrollment's audit trail.

## Next

- [Connect a radio: quick starts](quick-starts.md).
