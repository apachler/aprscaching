# Run from source

This page shows contributors how to run APRScaching from a checkout for development: one command starts the
gateway and the web app, and every edit is live within a second or two. You need Node 22 or newer and pnpm; at
the end the whole app runs on `http://localhost:5173`, signed in as the instance operator. To install an
instance for real use, see [Is running an instance for me?](../run/index.md).

## Before you start

- **Node 22 or newer** (CI uses 24).
- **pnpm**: `corepack enable` provides the version the repository pins.

## Install

```bash
pnpm install
pnpm run check    # build every unit, run every unit suite, typecheck and build the web app
```

## Start the instance

```bash
pnpm dev
```

The first run asks for the callsign that administers the instance (`N0CALL` if you press Enter, or set
`DEV_CALL`), then writes `.env.dev` at the top of the checkout. Every later run reuses it. Two processes start,
their output prefixed `gateway` and `web`:

- the **gateway** on Node + SQLite, port 8787, run from source;
- the **web app** on the Vite dev server, `http://localhost:5173`.

Open `http://localhost:5173`. The dev server hands every path the gateway serves to the gateway, the live
socket included, so the browser sees one origin as on a real instance: session cookies, passkeys, sign-in links,
media and live updates all work. Ctrl-C stops both.

**Check it worked:** the terminal prints the URL, and `curl -fsS http://localhost:5173/health` answers.

## Sign in as the operator

While no account holds the admin call, `pnpm dev` prints a single-use sign-in link for it:

<!-- ascii-ok: the line pnpm dev prints -->
```text
dev    │ sign in as N0CALL (single use, 15 minutes): http://localhost:5173/auth/email/verify?token=…
```

Open the link and confirm. The account is created, and `pnpm dev` verifies the call as the operator straight
away, so **Instance admin** appears in the menu after a reload. An admin call opens no account by email or
passkey without this link. If the link expired, `pnpm dev:admin` prints a new one.

After that, add a passkey under **Settings → Account** (**Add a passkey on this device**) and sign in with it:
`localhost` is a secure context, so passkeys work on plain http.

Other accounts sign in by email: the dev instance sends no mail, so the app shows the sign-in link at once and
the gateway log prints it too.

## What reloads, and how fast

| You edit | What happens | Live after |
|---|---|---|
| `apps/web/src` (components, styles) | Vite updates the page in place | under 0.1 s |
| `workers/gateway/src`, `servers/node/src`, `packages/*/src` | the gateway restarts from source | about 1 s |
| `db/migrations/*.sql` | the gateway restarts and applies a file it has not applied yet | about 1.5 s |
| `apps/ingest/src` (with `--ingest`) | the ingest restarts | about 0.5 s |

Every workspace package exports its TypeScript source, so nothing needs building between edits. The database
and media survive restarts, under `.dev/` (gitignored); delete `.dev/` to start with an empty instance. The
runner never applies a file twice, so an edit to `0001_baseline.sql` does not reach an existing `.dev/`
database: run `rm -rf .dev` and start `pnpm dev` again to build it from the edited schema.

## Settings

`.env.dev` holds what the dev instance needs and nothing else: fresh ingest, operator and session secrets, the
web-push keys, a federation key, `ADMIN_CALLSIGNS`, `ALLOW_DEV_TOKENS=1`, `FIRST_PARTY_SITES=OE8XXX` and
`UPDATE_CHECK=0`. Any other setting from the [configuration reference](../reference/configuration.md) added to
the file reaches the gateway as it is: `SMTP_HOST` to send real mail, `OFFLINE_TILES_PATH` for offline map
packs, `MIN_TRUST`, and so on. Restart `pnpm dev` after an edit. Delete the file to generate a new one.

The ports come from `DEV_WEB_PORT`, `DEV_GATEWAY_PORT` and `DEV_PEER_PORT` in the file, or from the command
line: `pnpm dev --port 5180 --gateway-port 8790`.

## Fill the map

```bash
pnpm dev:seed     # with pnpm dev running
```

It loads caches around Graz, stations, a rover track, a day of weather, APRS messages and finds. The stations
are heard through `OE8XXX`, the dev instance's trusted receiving station, so finds can reach Tier A.

Without a gateway at all, `/?demo=app` serves the whole app from canned answers, and `/?demo=ui` shows every
token and component ([Design and accessibility](testing.md#design-and-accessibility)).

## Feed it live APRS

```bash
pnpm dev --ingest
```

The ingest starts as well, prefixed `ingest`, and streams the APRS-IS slice `APRSIS_FILTER` names in `.env.dev`
(100 km around Graz to start with) into the gateway, receive only. A radio link (`KISS_TNC_HOST`,
`MESHTASTIC_HOST`, …) goes in `.env` at the top of the checkout, which the ingest reads too
([RF ingest & transports](../run/radios/rf-ingest.md)). `DEV_INGEST=1` in `.env.dev` starts the ingest every
time.

**Check it worked:** `curl -s http://localhost:5173/api/ports` counts `aprs-is` packets, and stations appear
on the map.

## Try federation

```bash
pnpm dev:peer
```

A second gateway starts on `http://127.0.0.1:8788`, prefixed `peer`, with its own database under `.dev/peer/`.
Each instance pins the other's key, so they trust each other from the start and pull every 15 seconds. A cache
hidden on one shows on the other as a mirrored cache. The peer serves the web app when a production build
exists (`pnpm --filter @aprscaching/web build`). It opens on `127.0.0.1`, another host than `localhost`, so the
two keep separate sign-ins in one browser; sign in there by email link, since a passkey needs a domain name.

## Test the production build

```bash
pnpm dev:preview
```

The gateway serves the production build itself on `http://localhost:8787`, as a Pi or the desktop app does.
Use it for what only a build has: the service worker and the offline app shell, the prerendered landing page,
and offline packs (an offline map needs `OFFLINE_TILES_PATH` in `.env.dev`). The build reruns on each change
(about 2 s); reload the page to see it.

Web push works on `localhost` in Chrome and Firefox, under `pnpm dev` and `pnpm dev:preview` alike: switch it on
under **Settings → Notifications**.

## Check the dev stack

```bash
pnpm dev:check
```

It starts the stack on free ports with throwaway settings and proves each path through the one origin: the page
and the hot-reload socket, an API call, an email sign-in and its session, the operator link and Instance admin,
hiding a cache with a photo, logging a find, a packet arriving on the live socket, and a passkey registration
and sign-in in Chromium. It needs a Chromium: `CHROMIUM_PATH`, or `pnpm exec playwright-core install
chromium`.

## Run the parts on their own

The parts start separately too. The gateway then needs its settings in the environment:

```bash
INGEST_SECRET=$(openssl rand -hex 24) APP_URL=http://localhost:5173 pnpm dev:gateway   # :8787, restarts on edits
pnpm dev:web                                                                           # :5173, proxies to :8787
cp .env.example .env && pnpm dev:ingest                                                # set INGEST_SECRET to the same value
```

On Bun, the gateway runs with `INGEST_SECRET=<your secret> bun run servers/bun/server.ts`; both runtimes serve
the same API and pass the same conformance suites ([Architecture and runtimes](architecture.md)).

## Check your checkout

```bash
pnpm run check               # build + every unit suite (includes the web guards)
pnpm run smoke               # a throwaway gateway and the conformance smoke suites
pnpm run verify              # both: the full gate before committing
```

## Next

- [Testing & verification](testing.md): every check and how to run one test.
- [Architecture and runtimes](architecture.md): where a change belongs.
