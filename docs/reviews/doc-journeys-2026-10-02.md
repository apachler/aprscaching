# Documentation by audience: journeys and move map — October 2026

!!! info "Review dated 2 October 2026"
    This is a point-in-time review record. It describes the manual on `dev` at commit `d4238e3` and the plan to
    reorganise it by audience. It is not updated as the manual moves. The inventory it builds on is
    [Documentation inventory — October 2026](doc-inventory.md); the writing standard it applies is the
    [Style guide](../contribute/style-guide.md).

## Status: approved, and done

The owner approved this plan as written on 2 October 2026; the record of what was done is under
[Outcome](#outcome-2-october-2026) at the end. The status as it stood before the approval follows.

The handover asks for this move map to be shown to the owner **before anything moves**. The owner is away, so
this record and its pull request are where the plan waits, and nothing below has been moved. What went ahead,
because it moves nothing:

- the style guide;
- Vale in CI;
- small fixes to things that are wrong today.

Phase 2 starts once the owner approves or amends this plan. It covers:

- the restructure and the link updates;
- the stale-link check;
- the 404 page;
- the in-app nav built from `mkdocs.yml`.

Decisions applied (from the handover):

- **G1 audience first.**
  - Sections: Play · The Shack · Run an instance · Reference · Contribute, plus Glossary and About.
  - Files live under `docs/play`, `docs/shack`, `docs/run`, `docs/reference` and `docs/contribute`.
  - Each section opens with a journey landing page.
- **G2 cache types.**
  - An overview page with a comparison table.
  - One page per game type: traditional, multi, living, audio and virtual.
  - One shared page for the heritage types: SOTA, POTA, WWFF, bunker and castle.
- **G3 Vale** in the docs workflow. Errors fail; warnings and suggestions show. Readability is checked on Play.
- **G4 no redirects.**
  - Every link is updated where it is.
  - A check fails on links to pages that do not exist: relative links, in-app slugs and published URLs.
  - The 404 page points to the five section landings.

Questions for the owner. The plan proceeds as written unless the owner amends it:

1. **Two pages beyond the target list.** `play/account.md` (sign-out, several callsigns, licence badge,
   settings, your data) and `play/offline.md` have no home in the target list. Each is too large to fold into
   another page.
2. **Depth of Run an instance.** The proposed nav has sub-groups: Install, Radios, Networks, Federation, Pocket
   in the field, Day to day and Compliance. If the nav should stay shallower, the two 44Net pages can fold back
   into one, and so can the two federation pages.
3. **Dated reviews and G4.** Links inside `docs/reviews/` are history. They are updated with the move, so that
   `mkdocs build --strict` stays green, rather than excluded from the link check.
4. **What players are told where the app has no UI.** Owners cannot edit, disable, archive or add stages to a
   cache in the app; that is API-only. Player pages will say "not in the app yet; ask your sysop" rather than
   point at the API, and the gap goes on the UX list.

## Readers and journeys

| Reader | Wants | Journey |
|---|---|---|
| **Player** (primary) | to find caches and log them | What is APRScaching? → Join → Your first find → Cache types → Find a cache → Log a find (app, offline, radio) → How finds are verified → Community → Getting to your instance → Help & FAQ |
| **Hider** | to place and keep a cache | Before you hide → Hide your first cache → Options per type → Stages and unlocks → Living caches and rendezvous → Who sees your cache → Maintain, archive, adopt |
| **Shack user** | to operate a station | The Shack at a glance → Your radio in the browser → Packet terminal and BBS → Messages over APRS and MeshCom → Rig control and weather → On-air etiquette and rules |
| **Sysop** | to run an instance | Is it for me? → Choose a shape → Install → First hour → Radios → Networks → Federation → Day to day → Compliance → Troubleshooting |
| **Integrator** | to build on it | API overview → Auth → Endpoints → Federation wire → Formats → Configuration → CLI |
| **Contributor** | to change it | Run from source → Architecture → Testing → Design notes → Style guide → Specs |

Player pages carry no shell commands, configuration keys, file paths or server internals.

## Proposed nav

Home becomes a "Who are you?" page with four doors: Play · Run an instance · Build on it · Contribute.

```yaml
nav:
  - Home: index.md
  - Play:
      - What is APRScaching?: play/index.md
      - Join: play/join.md
      - Your first find: play/first-find.md
      - Cache types:
          - Overview: play/cache-types/index.md
          - Traditional: play/cache-types/traditional.md
          - Multi-stage: play/cache-types/multi.md
          - Living cache: play/cache-types/living.md
          - Audio: play/cache-types/audio.md
          - Virtual: play/cache-types/virtual.md
          - Heritage places: play/cache-types/heritage.md
      - Find a cache: play/find-a-cache.md
      - Hunting without signal: play/offline.md
      - Log a find: play/log-a-find.md
      - How finds are verified: play/verification.md
      - Hide a cache: play/hide-a-cache.md
      - Community: play/community.md
      - Your account: play/account.md
      - Getting to your instance: play/your-instance.md
      - Help and FAQ: play/help-faq.md
  - The Shack:
      - The Shack at a glance: shack/index.md
      - Your radio in the browser: shack/my-radio.md
      - Packet terminal & BBS: shack/packet-and-bbs.md
      - Messages over APRS and MeshCom: shack/messages.md
      - Rig control & weather: shack/rig-weather.md
      - On-air etiquette and rules: shack/on-air.md

  - Run an instance:
      - Is running an instance for me?: run/index.md
      - Choose a shape: run/choose-a-shape.md
      - Install:
          - Self-host with Docker (recommended): run/install/self-host-docker.md
          - Self-host without Docker: run/install/self-host-bare-metal.md
          - Desktop: run/install/desktop.md
          - Cloudflare split: run/install/cloudflare-split.md
          - "Pocket: an Android phone": run/install/pocket.md
          - Check a download: run/install/verified-downloads.md
          - The offline map: run/install/offline-map.md
      - Your first hour: run/first-hour.md
      - Connect radios:
          - Quick starts: run/radios/quick-starts.md
          - Set up an ingest box: run/radios/ingest-box.md
          - RF ingest & transports: run/radios/rf-ingest.md
          - MeshCom: run/radios/meshcom.md
          - "Packet: BBS & NET/ROM node": run/radios/packet-node.md
          - Remote control of your box: run/radios/remote-box.md
      - Networks:
          - Off-grid and LAN: run/networks/off-grid.md
          - Cloudflare Tunnel and CDN: run/networks/cloudflare.md
          - 44Net address: run/networks/44net.md
          - 44Net name and identity: run/networks/44net-identity.md
          - HAMNET only: run/networks/hamnet.md
      - Federation:
          - Join the network: run/federation/index.md
          - Hubs, relays and the registry: run/federation/hubs-and-relays.md
      - Pocket in the field:
          - Run Pocket in the field: run/pocket/field-station.md
          - Pocket extras: run/pocket/extras.md
          - Reach Pocket from outside: run/pocket/44net.md
          - "Before a trip: sync and your home hub": run/pocket/trips.md
      - Day to day:
          - Instance admin at a glance: run/day-to-day/index.md
          - The deploy/aprscaching command: run/day-to-day/helper-command.md
          - Backups and moving: run/day-to-day/backups.md
          - Updates: run/day-to-day/updates.md
          - One-time sign-in links: run/day-to-day/sign-in-links.md
          - Callsign verification: run/day-to-day/callsign-verification.md
          - Cache adoption: run/day-to-day/cache-adoption.md
          - Licence registers: run/day-to-day/licence-registers.md
          - Import heritage places: run/day-to-day/import-places.md
      - Compliance:
          - A public instance's duties: run/compliance/index.md
          - Automatic stations on the air: run/compliance/on-air-stations.md
          - Data protection (GDPR): run/compliance/data-protection.md
      - Troubleshooting: run/troubleshooting.md

  # additions elsewhere, from this split
  - Reference:
      - Secrets and credentials: reference/secrets.md            # new: deployment#Secrets + administration#Machine credentials/#Sessions/#Operator identity + helpers#Rotating
      - How federation stays honest: reference/federation-trust.md  # new: federation#Signed feeds/#One row/#mirrors/#registry/#corroboration
      - Rig control library: reference/rig-library.md            # new: rig-weather codec + rigctld
  - Contribute:
      - Architecture and runtimes: contribute/architecture.md    # new: deployment#The three gateway runtimes, docker#The image/#Standalone images
      - The AX.25 stack: contribute/ax25-stack.md                # new: packet#Connected-mode AX.25 internals
      - Writing a Shack plugin: contribute/plugins.md            # new: shack#For plugin authors
```

The Reference section keeps its current paths: API, configuration, CLI, Cloudflare costs, data model,
federation wire, MeshCom ExtUDP and licence registers. It gains `trust-model.md`, `callsign-verification.md`,
`secrets.md`, `federation-trust.md` and `rig-library.md`.

Contribute takes:

- `run-from-source.md` (from `getting-started.md`);
- `architecture.md` (new, with one Mermaid diagram);
- `testing.md`;
- `design/` (the four design notes);
- the style guide and `specs.md`.

Glossary and About stay at the top level.

## Move map — Play

Every H2 and H3 of the player-facing pages, with where it goes.

| Source file#heading | Destination | Action | Note |
|---|---|---|---|
| `index.md` (H1 + intro, "I want to…" table, tip) | `docs/index.md` (stays as the manual home; audience router) | rewrite | The router table becomes the 5-section chooser (Play · Shack · Run · Reference · Contribute). Tip box (sign in, verify, first find) moves to `play/index.md`. |
| `index.md#two-things-in-one-application` | "The cache game" para → `docs/play/index.md`; "The Shack" para → `docs/shack/index.md` | split | Heritage list mentions "islands" (IOTA imports as `traditional`, not a type of its own). |
| `index.md#trust-follows-the-radio-not-the-transport` | `docs/play/verification.md` (player summary) + `docs/reference/trust-model.md` (lead-in) | split / rewrite for players | Player version drops "APRS-IS"/"transport" jargon or glosses it. |
| `index.md#a-map-that-forgets` | `docs/about.md#privacy-by-default` (already there) + one-line teaser on `docs/index.md` | delete-duplicate | Duplicate of about.md §Privacy. |
| `index.md#architecture-at-a-glance` | `docs/contribute/architecture.md` (and a one-paragraph version on `docs/run/index.md`) | move | Contains package names (`@aprscaching/*`), runtime internals — unsuitable for players. |
| `start-here.md` (H1 intro) | `docs/play/index.md` | merge | Good player tone; keep. |
| `start-here.md#pick-your-path` | `docs/index.md` router | delete-duplicate | Same job as the index table. |
| `start-here.md#play-in-five-minutes` | `docs/play/first-find.md` (steps 1, 3, 4 as the tutorial); step 2 → `docs/play/join.md`; step 5 → `docs/play/hide-a-cache.md` ("Your first cache") | split | Step 2 shows `VERIFY 482913`/`APRSCG` — fine for players (it's what they key in), but `<call>.ampr.org` detail belongs in join.md. |
| `start-here.md#how-finds-are-verified` | `docs/play/verification.md` | merge | Near-duplicate of caching.md#log-a-find table and index.md trust para; consolidate into one page. |
| `start-here.md#connect-your-radio` | `docs/shack/my-radio.md` (link from `play/log-a-find.md` radio section) | move | Shack audience. |
| `start-here.md#run-your-own-instance` | `docs/run/index.md` | move | Contains `deploy/setup.sh` path — not for players. A one-line "your club can run one" pointer stays in `play/your-instance.md`. |
| `guides/account.md` (H1 intro) | `docs/play/join.md` | move | |
| `guides/account.md#sign-in` | `docs/play/join.md#sign-in` | move | Mentions `https://` vs `http://` passkey constraint — keep as a plain-language FAQ entry. |
| `guides/account.md#sign-out` | `docs/play/account.md` | move | |
| `guides/account.md#verify-your-callsign` | `docs/play/join.md#verify-your-callsign` | move | Method table is player-appropriate. |
| `guides/account.md#on-the-air` | `docs/play/join.md` | move | Keep the "only a direct hearing counts" paragraph, shortened. |
| `guides/account.md#ampr-org-dns` | steps → `docs/play/join.md`; the `??? note "How the instance knows the record is genuine"` (DNSSEC, resolver quorum) → `docs/reference/callsign-verification.md` | split | Note contains server internals; "as checked on 2026-09-30" is a dated statement. |
| `guides/account.md#lotw-certificate` | `docs/play/join.md` (steps); trust-chain paragraph → `docs/reference/callsign-verification.md` | split | |
| `guides/account.md#the-licence-badge` | `docs/play/account.md` | move | Links `reference/licence-sources.md` — fine. |
| `guides/account.md#several-callsigns` | `docs/play/account.md` | move | Must be corrected: "Past finds stay with the call they were logged under" is true, but SSID finds do not reach the leaderboard (see Known issues). |
| `guides/account.md#your-finds-are-signed` | `docs/play/log-a-find.md#your-finds-are-signed` | move | |
| `guides/account.md#settings-at-a-glance` | `docs/play/account.md` | move | "Home weather station", "My radio" rows link to Shack pages. |
| `guides/account.md#your-data` | `docs/play/account.md#your-data` | move | |
| `guides/caching.md` (H1 intro) | `docs/play/index.md` | merge | |
| `guides/caching.md#finding-your-way-around` | `docs/play/find-a-cache.md` (nav table) — or `play/index.md` "Finding your way around" | move | |
| `guides/caching.md#the-map` | `docs/play/find-a-cache.md#the-map` (search & filter, basemap, map tools, readout); "Live layers" bullet → `docs/shack/live-map.md` | split | "Download this area" → offline section of find-a-cache. |
| `guides/caching.md#live-stations-and-spots` | `docs/shack/live-map.md` | move | Operator/Shack audience; one sentence + link kept in find-a-cache. |
| `guides/caching.md#meshcom-on-the-map` | `docs/shack/live-map.md#meshcom` | move | RSSI/SNR, relays — operator content. |
| `guides/caching.md#cache-types` | `docs/play/cache-types/index.md` (comparison table) + per-type pages | rewrite for players / split | Current table is 6 rows, no per-type detail; per-type template (G2) must be written from code (see Game coverage). |
| `guides/caching.md#open-a-cache` | `docs/play/find-a-cache.md#open-a-cache` | move | |
| `guides/caching.md#log-a-find` | `docs/play/log-a-find.md` (how) + tier table → `docs/play/verification.md` | split | "recorded as **Logged**" when a cache requires a higher tier is inaccurate (it keeps its tier, marked not verified). |
| `guides/caching.md#log-from-your-radio` | `docs/play/log-a-find.md#from-your-radio` | move | Mentions "attested sites" (glossary-linked) — OK; keep the q-construct out. |
| `guides/caching.md#the-youre-near-prompt` | `docs/play/find-a-cache.md#youre-near` | rewrite for players | Prompt is driven by your **APRS beacon** heard near a cache (150 m), not by the phone's GPS — current wording implies phone. |
| `guides/caching.md#staged-caches` | `docs/play/cache-types/multi.md` (+ `audio.md`) "How you find it" | move / rewrite | Geo unlock is at the *previous* stage's radius (default 60 m). |
| `guides/caching.md#hide-a-cache` | `docs/play/hide-a-cache.md` (first cache, visibility) | rewrite for players | Contains `PATCH /api/caches/:id`, `POST /api/caches/:id/stages` — API paths must leave the player page (→ `docs/reference/api.md`); "Unlisted — shared, but not listed" is wrong (see Gap). |
| `guides/caching.md#adopt-a-cache` | `docs/play/hide-a-cache.md#maintain-and-adopt` | move | "until you edit it and set it active" — there is no edit UI. |
| `guides/caching.md#community` | `docs/play/community.md` | move / expand | No badge list, no points formula, no rating policy. Rendezvous sentence → `cache-types/living.md`. |
| `guides/caching.md#sharing-and-exporting` | Share/QR → `docs/play/find-a-cache.md`; GPX/KML/ADIF → `docs/play/community.md` short pointer + `docs/reference/api.md#public-read-api` | split | Read-API link is developer content. |
| `guides/caching.md#heritage-places-on-the-map` | `docs/play/cache-types/heritage.md`; "How to import" → `docs/run/administration.md` | split | Lists IOTA, GCAU, OpenCaching, OSM, Wikidata — those import as `traditional`/`multi` or a sysop-chosen type, not as heritage types. |
| `guides/offline.md` (H1 intro) | `docs/play/find-a-cache.md#offline` or a sub-page `docs/play/offline.md` | move | Offline is large; recommend `docs/play/offline.md` linked from Find + Log (see Notes). |
| `guides/offline.md#before-you-go` | `docs/play/offline.md` | move | |
| `guides/offline.md#offline-packs` | `docs/play/offline.md#offline-packs` | move | Link to `operate/offline-map.md` is sysop content — keep as "if your instance offers one". |
| `guides/offline.md#out-there` | `docs/play/offline.md`; multi-stage/NFC paragraph → `docs/play/cache-types/multi.md#offline` | split | |
| `guides/offline.md#back-online` | `docs/play/log-a-find.md#offline` (queue, needs attention) + `docs/play/offline.md#sync` | split | "the cache was archived meanwhile" refusal does not exist in code (see Known issues). |
| `guides/offline.md#where-this-helps` | Pocket bullet → `docs/run/pocket.md`; others → `docs/play/help-faq.md` or `play/offline.md` | split | |
| `concepts.md` (H1 intro + "In plain words") | `docs/reference/trust-model.md`; plain-words para → `docs/play/verification.md` | split | |
| `concepts.md#verification-tiers` | `docs/reference/trust-model.md#tiers`; player version → `docs/play/verification.md` | split / rewrite for players | Contains `qAR,<site>`, `min_trust` (config/field name). |
| `concepts.md#corroboration-and-quorum` | `docs/reference/trust-model.md#corroboration` (+ one player sentence: "other instances can confirm") | move | Server internals. |
| `concepts.md#transport-is-not-trust` | `docs/reference/trust-model.md#transport-is-not-trust` | move | `FIRST_PARTY_SITES`, `RF_SITE_CALL`, `apps/ingest`, provenance object — unsuitable for players. |
| `concepts.md#identity` | `docs/reference/trust-model.md#identity`; player bits already in `play/join.md` | move / delete-duplicate | Mentions operator CLI. |
| `concepts.md#federation` | `docs/run/federation.md` (intro) | merge | Duplicates guides/federation.md. |
| `concepts.md#runtimes-and-locality` | `docs/contribute/architecture.md` + `docs/run/index.md` | move / delete-duplicate | Duplicates index.md architecture + CLAUDE.md. |
| `glossary.md` (intro) | `docs/glossary.md` (top-level) | keep | Retarget every link to new pages. |
| `glossary.md#radio-and-aprs` | glossary | keep | Links to `operate/*` → `run/*`. |
| `glossary.md#aprscaching` | glossary | keep / edit | "Sysop … listed in `ADMIN_CALLSIGNS`" — config key in a player-facing definition; move key to run docs. "Living cache" link → `play/cache-types/living.md`. Add: stage, NFC stage, rendezvous, adoption, offline pack, heritage cache, D/T. |
| `about.md#privacy-by-default` | `docs/about.md` | keep | Contains `workers/gateway/src/app.ts`, `RETENTION`, `GET /privacy` — acceptable in About, but a player-safe 3-line summary should go on `play/index.md`. |
| `about.md#licensing` | `docs/about.md` | keep | Contributor-relevant "inbound = outbound" also linked from `docs/contribute/`. |
| `about.md#credits--trademarks` | `docs/about.md` | keep | |
| `getting-started.md` (H1 intro) | `docs/contribute/run-from-source.md` | move | |
| `getting-started.md#install` | `docs/contribute/run-from-source.md` | move | Shell commands. |
| `getting-started.md#run-the-gateway` | `docs/contribute/run-from-source.md` | move | |
| `getting-started.md#run-the-web-app` | `docs/contribute/run-from-source.md` | move | |
| `getting-started.md#add-rf-ingest-optional` | `docs/contribute/run-from-source.md` (dev only) ; the "Off-grid works" note → `docs/run/index.md` | split | Duplicates `operate/quickstarts.md`. |
| `getting-started.md#verify-your-checkout` | `docs/contribute/testing.md` (merge with reference/testing.md) | merge | |
| `getting-started.md#where-to-next` | `docs/contribute/run-from-source.md` | rewrite | Retarget links. |

Pages with no source today (write from code): `cache-types/*` per-type pages, `community.md` (badges, points, ranks, ratings), `your-instance.md` (instances, remote caches, home instance, `.com`→`.net`), `help-faq.md`.

## Move map — The Shack

| Source#heading | Destination | Action | Note |
|---|---|---|---|
| guides/shack.md#(intro) "The Shack" | shack/index.md "The Shack at a glance" | move | Good player-facing intro. Mentions "Two apps ... shown only to its operator" — keep one line, link to run/. |
| guides/shack.md#The apps | shack/index.md | move | The table is the spine of the section; each row should link to its Shack page (packet terminal/BBS → packet-and-bbs, Rig control → rig-weather, NET/ROM node + Remote box → run/radios/*). Drop the "Rig control ... See my-radio#rig-control" cross-link (rig control moves). |
| guides/shack.md#Packet decoder | shack/packet-and-bbs.md §"Decode a packet" | move | Fine for players; the q-construct aside links glossary. |
| guides/shack.md#CW and PSK31 by ear | shack/index.md §"Tools" (or packet-and-bbs) | move | Belongs with Tools; short. |
| guides/shack.md#BBS, node and forwarding | shack/packet-and-bbs.md §"The instance's BBS and node" | merge with packet.md#BBS (connectionless, user view) | Currently only a pointer to the operator page; needs 2–3 sentences of what the user does (send mail, read bulletins, connect to the node) before linking run/radios/packet-node. |
| guides/shack.md#Remote box | run/radios/remote-box.md | merge with administration.md#Remote control of your box | Operator-only app (audience mismatch on a player page). Leave a one-line row in shack/index linking to it. Duplicates deployment.md#Operator scripts… "Remote boxes are paired" bullet. |
| guides/shack.md (stray line "Live stations and spots are map layers…") | shack/index.md (see-also) or delete | rewrite | Orphan line between sections; belongs to Play (caching map). |
| guides/shack.md#Tools and plugins | shack/index.md §"Tools and plugins" | move | Player-facing trust labels — keep. |
| guides/shack.md#Tools and plugins ### For plugin authors | contribute/plugins.md | move | Contributor internals in a how-to (capabilities, surfaces, manifest, toolkey). Explicitly flagged "for developers". |
| guides/my-radio.md#(intro) | shack/my-radio.md | move | |
| guides/my-radio.md#What you need | shack/my-radio.md | move | Links `../operate/pocket.md`, `../operate/rf-ingest.md` → update to run/install/pocket, run/radios/ingest-box. |
| guides/my-radio.md#Connect | shack/my-radio.md | move | |
| guides/my-radio.md#Send what you hear to an instance | shack/my-radio.md | move (owner) | Duplicated almost verbatim by pocket.md#Your radio in the browser (signed vs secret). my-radio owns it. The "secret (self-host)" sub-bullet is a sysop-to-self path; fine here. |
| guides/my-radio.md#Transmit (optional) | shack/my-radio.md §Transmit; message steps cross-linked from shack/messages.md | move | The "Message — enter to and message" step is the only how-to for sending an APRS message today; messages.md should own it and my-radio link it. Compliance pointer → shack/on-air.md. |
| guides/my-radio.md#Rig control | shack/rig-weather.md §"Tune your radio" | merge with rig-weather.md#CAT rig control | Two pages describe the same app; rig-weather.md even says "step by step: my-radio#rig-control". One page. |
| guides/my-radio.md#Troubleshooting | shack/my-radio.md | move | Rig-control has no troubleshooting row; fine. |
| operate/rig-weather.md#(intro) / ## CAT rig control | shack/rig-weather.md | merge with my-radio#Rig control | Gate statement (PTT gated, tuning not) stays. Is in nav under Guides already but lives in operate/. |
| operate/rig-weather.md ### In the browser (Web Serial) | shack/rig-weather.md (radio families list) + reference/rig-library.md (codec: `catSetFrequency`, `@aprscaching/aprs`) | split | Player needs the three radio families; codec function names are library/contributor material. |
| operate/rig-weather.md ### Library: Hamlib `rigctld` client | reference/rig-library.md (or contribute/) | move | Integrator content; "planned … TODO.md" also borders on journey wording. Leave one line in shack/rig-weather: "Radios outside these families need a Hamlib program". |
| operate/rig-weather.md#Weather stations | shack/rig-weather.md §"Your weather station" (direct push, WX beacon) + run/radios/rf-ingest.md or reference/configuration (CWOP_HOST/PORT) + reference/api (endpoints) | split | Mixed audience: Settings → My stations (user), `CWOP_HOST` (sysop), `POST /api/wx/*` (API reference). Keep the "weather never touches tiers" line. |
| (new) | shack/messages.md "Messages over APRS/MeshCom" | rewrite (new page) | No current page owns messaging. Sources: my-radio#Transmit (Message), packet.md#BBS bullet 2 (personal mail held until heard, `APRSCG`), meshcom.md#What you see (message log, group text only in monitor), meshcom.md#Answering radio commands (what players send: `FOUND`, `VERIFY` → link Play pages), pocket.md#Extras "Field alerts" (vibrate on a DM). Needs fresh text: Messages surface, inbox, acks. |
| operate/rf-regulatory.md#(intro), #You are the control operator, #No encryption on the air, #Station identification, #Third-party traffic, #No commercial | shack/on-air.md "On-air etiquette and rules" | split | The individual operator (browser TX, beacon, message) needs these. Keep the "not legal advice" box. |
| operate/rf-regulatory.md#Automatic & unattended operation, ### Transmit pacing, #Bandwidth…, #44net and HAMNET, #What aprscaching enforces | run/compliance/on-air-stations.md | split | Sysop of digipeater/IGate/node/BBS. Pacing table is configuration reference — could also live in reference/configuration; keep on page. |
| operate/packet.md (whole) | see Run table | — | User side is shack/packet-and-bbs; operator side is run/radios/packet-node. |

## Move map — Run an instance

#### deployment.md (2,685 words)

| Source#heading | Destination | Action | Note |
|---|---|---|---|
| deployment.md#(intro) | run/index.md "Is running an instance for me?" + run/choose-a-shape.md | split | Intro already does "pick a shape → first hour"; becomes the journey lead. |
| deployment.md#Which shape should I pick? | run/choose-a-shape.md | move (owner) | Becomes the one decision page: comparison table + "Self-host is the default" callout. |
| deployment.md#The three gateway runtimes | contribute/architecture.md (runtimes table) + one row "Runtime" in choose-a-shape table | split | Package names (`workers/gateway`, `servers/node`) are contributor detail; the operator only needs "all shapes have the full feature set". |
| deployment.md#Three ways to deploy (table) | run/choose-a-shape.md | merge with #Which shape | The "Walkthrough" column becomes links to run/install/*. Omits Pocket and bare metal; add both. |
| deployment.md ### Self-host — helper line + setup.sh ingress bullets | run/install/self-host-docker.md | merge with docker.md#Full stack | Duplicate of docker.md#Before you start (ingress options) and first-hour step 1. |
| deployment.md ### Self-host — 44Net by-shape table | run/networks/44net.md §"By shape" | merge with helpers.md#44Net | Same facts as helpers#Commands by shape `net44` row and pocket#Pocket on 44Net. |
| deployment.md ### Self-host — Oracle one-click stack + "Staying on the free tier" | run/install/self-host-docker.md §"On Oracle Cloud" (or run/install/oracle-cloud.md if it grows) | move | Self-host variant; links `deploy/oci/README-stack.md`. |
| deployment.md ### Self-host — Bare metal paragraph | run/install/self-host-bare-metal.md | merge with helpers.md#Bare metal | helpers has the full procedure; deployment repeats the summary. |
| deployment.md ### Self-host behind Cloudflare | run/networks/cloudflare.md | merge with docker.md#Cloudflare Tunnel ingress | Tunnel bullet duplicates docker's tunnel steps; CDN bullet (cache-rules.sh, TRUST_CF) is unique and lives only here. |
| deployment.md ### Desktop | run/install/desktop.md | merge with helpers (desktop `init` line, Verified downloads) + `deploy/desktop/README.md` substance | Currently no manual page walks a Desktop install (table points at a README). |
| deployment.md ### Cloudflare split | run/install/cloudflare-split.md | merge with helpers.md#Cloudflare split | Internal duplicate: cost warning admonition + "Cost scales with rows written" paragraph say the same thing twice; keep one, link reference/cloudflare-costs. |
| deployment.md#Secrets every deployment sets | reference/secrets.md | merge with administration#Machine credentials, #Sessions, helpers#Rotating a secret | Reference-shaped (table of three secrets × shapes). Install pages keep one line each. |
| deployment.md ### Operator scripts, sessions and remote boxes | reference/secrets.md (OPERATOR_SECRET, SESSION_SECRET bullets); run/radios/remote-box.md (pairing); contribute/ (CORS_ORIGINS for `pnpm dev:web`) | split | The `pnpm dev:web` CORS bullet is contributor content in an operator page. |
| deployment.md#Where RF comes in | run/index.md (one paragraph: "RF ingest is always on your own equipment") + run/networks/off-grid.md | split / delete-duplicate | Same text as rf-ingest.md#Off-grid and docker.md#Off-grid. |
| deployment.md#Two required obligations for a public instance | run/compliance/index.md | move | Also in first-hour step 6 (SOURCE_REPO, backup cron). |
| deployment.md#Backups | run/day-to-day/backups.md | merge with helpers#Backup and restore, docker#Upgrades (backup bullet), pocket#Backup | Owner of bucket lifecycle rules + D1 Time Travel. doctor links here 6× (`deployment.md#backups`). |
| deployment.md#Sign your feeds | run/federation/index.md §"Sign your feeds" | merge with federation.md#Joining step 1 | Duplicate. |

#### docker.md (1,502 words)

| Source#heading | Destination | Action | Note |
|---|---|---|---|
| docker.md#(intro) | run/install/self-host-docker.md | move | |
| docker.md#Before you start | run/install/self-host-docker.md | move (owner) | Ingress choices overlap deployment#Self-host; keep here, decision lives on choose-a-shape. |
| docker.md#The image | run/install/self-host-docker.md (one line) + contribute/architecture.md (Dockerfile build details) | split | `docker build` by hand is rarely needed by the operator (compose builds it). |
| docker.md#Full stack — commands block | run/install/self-host-docker.md | move (owner) | Same commands as first-hour step 2. |
| docker.md#Full stack — setup.sh paragraph | run/install/self-host-docker.md | move (owner) | Near-verbatim copy in first-hour step 1 (list of written keys). |
| docker.md#Full stack — federation posture paragraph | run/federation/index.md §"What the installer sets" | move | Wizard flags `--fed-peers`, `--fed-submit-instances`, `--fed-registry-key`, `--net44-name`; installer page keeps one sentence. Overlaps helpers.md#Self-host. |
| docker.md#Full stack — "Every setting in deploy/.env reaches both" | run/install/self-host-docker.md | move | |
| docker.md#Full stack — services table + operational defaults | run/install/self-host-docker.md §"What runs" | move | Secret notes in the table duplicate deployment#Secrets; trim to a link. |
| docker.md ### Cloudflare Tunnel ingress | run/networks/cloudflare.md §Tunnel | merge with deployment#Self-host behind Cloudflare | Owner of the 5 steps. Pocket's tunnel bullet links here too (`deploy/pocket/README.md:247`). |
| docker.md ### The operator RF box for a remote gateway | run/radios/ingest-box.md | merge with helpers#Ingest box, quickstarts#Before you start, rf-ingest#Enrolling | Also the "cloud APRS-IS feed" variant. |
| docker.md ### Off-grid | run/networks/off-grid.md | merge with deployment#Where RF comes in, rf-ingest#Off-grid | |
| docker.md#RF hardware from a container | run/radios/rf-ingest.md §"From a container" | move | Quickstarts' "Docker and your radio" note links here; MeshCom port paragraph also in meshcom.md#Firewall — cross-link. |
| docker.md#Upgrades, backups, logs | run/day-to-day/updates.md (upgrade), backups.md (backup), self-host-docker §Logs | split / delete-duplicate | Backup bullet repeats deployment#Backups nearly word for word (lifecycle, BACKUP_PRUNE_BUCKET). |
| docker.md#Standalone images | contribute/architecture.md (or a footnote on self-host-docker) | move | Mix-and-match builds are niche. |
| docker.md#What Docker does NOT cover | delete | delete-duplicate | Restates choose-a-shape; the interop peers note belongs in contribute/testing. |

#### helpers.md (3,091 words)

| Source#heading | Destination | Action | Note |
|---|---|---|---|
| helpers.md#(intro) (command list, shape detection table) | run/day-to-day/helper-command.md "The deploy/aprscaching command" | move | Shape-detection table is reference-ish; keep on page. |
| helpers.md#Verified downloads | run/install/verified-downloads.md | move | Shared by every install page and pocket.md#Install; release-verify.yml cites it. |
| helpers.md#Options | run/day-to-day/helper-command.md | move | |
| helpers.md#Commands by shape | run/day-to-day/helper-command.md | move | Also the backbone of each install page's "With the helper" line. |
| helpers.md#doctor | run/day-to-day/helper-command.md §doctor (how to run, JSON) + run/troubleshooting.md (the per-group table, expanded per check) | split | The group table becomes the troubleshooting index. |
| helpers.md#Backup and restore | run/day-to-day/backups.md | merge with deployment#Backups | Two backup tools (`deploy/aprscaching backup` archive vs `deploy/backup.sh` cron) explained in two places; one page must explain both and when to use which. |
| helpers.md ### Moving between shapes | run/day-to-day/backups.md §"Move to another shape" (link from choose-a-shape) | move | |
| helpers.md#Update | run/day-to-day/updates.md | merge with docker#Upgrades bullet, pocket update lines | |
| helpers.md#Self-host | run/install/self-host-docker.md | delete-duplicate | 36 words; says only "init selfhost runs setup.sh". |
| helpers.md#Ingest box | run/radios/ingest-box.md | merge (owner of the procedure) | |
| helpers.md#Cloudflare split | run/install/cloudflare-split.md | merge | |
| helpers.md#Bare metal | run/install/self-host-bare-metal.md | move (owner) | |
| helpers.md#44Net | run/networks/44net.md §"With the helper" | merge with 44net.md#2 | 44net#2 already explains each change; helpers repeats the four changes in brief. |
| helpers.md#Rotating a secret | reference/secrets.md §Rotation (table) + helper-command.md (the command) | split | doctor `config.secrets` links `helpers.md#rotating-a-secret`. |
| helpers.md#Settings are checked at start | reference/configuration.md (intro) | move | Applies to every shape; config reference is the natural home. doctor `config.value.*` already links configuration.md. |

#### first-hour.md (1,258 words)

| Source#heading | Destination | Action | Note |
|---|---|---|---|
| first-hour.md#(intro) | run/first-hour.md | move | Make it shape-neutral: it currently assumes Docker. |
| first-hour.md#The checklist step 1 (write config) | run/first-hour.md | rewrite | Duplicate of docker#Full stack setup.sh paragraph. Replace with "You ran the installer for your shape; check these values". |
| step 2 (start, health) | run/first-hour.md | delete-duplicate | Owned by install pages; first-hour starts at "it answers". |
| step 3 (sign in) | run/first-hour.md | move | |
| step 4 (confirm your call) | run/first-hour.md (owner of the procedure) | move | administration#Operator identity repeats the same command; that section becomes reference (how the sysop role is decided). |
| step 5 (blocking items) | run/first-hour.md | move | |
| step 6 (public-ready) | run/first-hour.md, linking compliance/index + day-to-day/backups | move | Overlaps deployment#Two obligations. |
| step 7 (attest RF site) | run/first-hour.md | move | Overlap with quickstarts step 6, rf-ingest#Receiving site; link, don't explain. |
| step 8 (join network) | run/first-hour.md → run/federation | move | |
| step 9 (44Net self-check) | run/networks/44net-identity.md §Self-check | delete-duplicate | Same as 44net.md#5. Keep a one-line conditional pointer. |
| "Other members verify…" + optional extras | run/first-hour.md | move | |
| !!! note "What the Setup page never writes" | run/first-hour.md (keep) or reference/secrets.md | move | |
| first-hour.md#Off-grid sign-in | run/day-to-day/sign-in-links.md "One-time sign-in links" | move (owner) | Linked from docker#Off-grid, deployment#Self-host, 44net TLS, 44net HAMNET table, administration#Machine credentials. |
| first-hour.md ### Visitors on the hotspot | run/day-to-day/sign-in-links.md §Visitors | merge with pocket#Visitors over https | Both describe `OPERATOR_LINKS_FOR_ANY_CALL`, the station CA, `--link-origin`. |

#### pocket.md (5,484 words) — see "Pocket split"

| Source#heading | Destination | Action | Note |
|---|---|---|---|
| pocket.md#(intro + diagram) | run/install/pocket.md | move | |
| #What it is and isn't | run/install/pocket.md | move | Also feeds the choose-a-shape table row. |
| #Install | run/install/pocket.md | move | Verified-download steps duplicate install/verified-downloads (keep the Termux commands, link the why). "Known issue: no release yet" box is time-bound. |
| #Run it | run/pocket/field-station.md | move | |
| #Keep it running | run/pocket/field-station.md | move | |
| #Extras… | run/pocket/extras.md | move | 684 words, its own page. |
| #Browsers on the phone | run/install/pocket.md | move | Needed before first sign-in. |
| #Visitors over https | run/day-to-day/sign-in-links.md §Visitors (shared) + run/pocket/field-station.md (`tls.sh` commands) | split | |
| #A MeshCom node | run/pocket/field-station.md | move | Trust rules duplicate meshcom.md#How MeshCom traffic is trusted; keep the one-line pointer only. |
| #A USB TNC on the phone | run/pocket/field-station.md | move | The prior-art paragraph (Termux_CDC_ACM, pyusb#287) is contributor background → contribute/ or a footnote. |
| #An RTL-SDR on the phone: not supported | run/pocket/field-station.md §"Not supported" | move | Combine with #Alternatives, not supported. |
| #Your radio in the browser | shack/my-radio.md | delete-duplicate | Restates my-radio#Send what you hear; keep 2 lines + the `INGEST_SECRET` grep tip. |
| #Reaching it from the internet | run/pocket/44net.md (renamed "Reach it from outside") | merge | Cloudflare bullet links run/networks/cloudflare. |
| #Pocket on 44Net | run/pocket/44net.md | move | 599 words; depends on run/networks/44net*. |
| #Federation: sync before a trip | run/pocket/trips.md | move | Mechanics (page caps, region) duplicate federation#Keeping mirrors fresh. |
| ### Your home instance as the hub | run/pocket/trips.md (phone side) + run/federation/hubs-and-relays.md (hub side, generic) | split | |
| ### If the phone is lost | run/pocket/trips.md | move | |
| #Backup | run/day-to-day/backups.md §Pocket | merge | deployment#Backups already has a Pocket bullet. |
| #Troubleshooting | run/pocket/field-station.md §Troubleshooting (or run/troubleshooting.md §Pocket) | move | Not doctor-derived; phone-specific. |
| #Tested on | run/install/pocket.md (bottom) | move | CI paragraph (`pocket-termux` workflow, Rolldown) is contributor content → contribute/testing. |
| #Alternatives, not supported | run/install/pocket.md §"Not supported" | move | |

#### offline-map.md, quickstarts.md, rf-ingest.md, meshcom.md, packet.md

| Source#heading | Destination | Action | Note |
|---|---|---|---|
| offline-map.md (all 3) | run/install/offline-map.md | move | Intro links Play's "Offline packs". HAMNET table row in 44net mentions "Instance-served tile packs are planned" — stale vs this page (the feature exists); fix on the HAMNET page. |
| quickstarts.md#(intro) | run/radios/quick-starts.md | move | |
| quickstarts.md#Before you start: the ingest box | run/radios/ingest-box.md | merge | Overlaps docker#operator RF box, helpers#Ingest box, rf-ingest#How the box works. |
| quickstarts.md#APRS-IS, #KISS TNC with Direwolf, #AGWPE, #WA8DED, #Your own IGate, #Digipeater, #Meshtastic, #AXUDP and AXIP | run/radios/quick-starts.md | move | KISS step 6 / IGate step 3 restate Tier A rule — link rf-ingest#receiving-site. IGate/Digipeater compliance warnings → link run/compliance/on-air-stations. |
| quickstarts.md#MeshCom | run/radios/quick-starts.md | move | Already a 2-line pointer — fine. |
| rf-ingest.md#(intro + tip) | run/radios/rf-ingest.md | move | |
| rf-ingest.md#How the box works | run/radios/rf-ingest.md | move | |
| rf-ingest.md#Enrolling the box | run/radios/ingest-box.md | merge | doctor `ingest.credentials` links `rf-ingest.md#enrolling-the-box` — update the anchor. |
| rf-ingest.md#Transports (table + 2 warnings) | run/radios/rf-ingest.md | move | MeshCom warning duplicates meshcom#How MeshCom traffic is trusted; tunnelled-frames warning has implementation words (`heardVia: aprs_is`, `firstPartyAttested`) → simplify, details to concepts. |
| rf-ingest.md#Receiving site and Tier A | run/radios/rf-ingest.md (owner) | move | Path-hop rule is dense but operator-relevant. |
| rf-ingest.md#IGate, #Digipeater | run/radios/rf-ingest.md | move | |
| rf-ingest.md#Off-grid | run/networks/off-grid.md | delete-duplicate | |
| rf-ingest.md#AXUDP and AXIP peering over 44Net | run/networks/44net.md §"Packet nodes over 44Net" (or run/radios/packet-node.md) | move | 44Net-specific; overlaps packet#Internet crosslinks and quickstarts#AXUDP. |
| rf-ingest.md#On-air legality | run/compliance/on-air-stations.md | delete-duplicate | Pointer only; keep one line. |
| meshcom.md (all sections) | run/radios/meshcom.md | move | Player-facing bits: "### Callsign verification over MeshCom" duplicates Play's account#verify — keep sysop half (trust rule) here, the player steps on the Play page. "### Answering radio commands" first sentence is player context, fine. |
| meshcom.md#Troubleshooting | run/radios/meshcom.md (keep) + rows linked from run/troubleshooting.md `ingest.meshcom.*` | move | |
| packet.md#(intro + warning) | run/radios/packet-node.md | move | |
| packet.md#Connected-mode AX.25 | contribute/ax25-stack.md (state machine, `connected.ts`, test status) + one paragraph and defaults table on packet-node.md | split | Contributor internals ("pure, event-driven … exhaustively testable") in an operator how-to. |
| packet.md#NET/ROM node, ### INP3 | run/radios/packet-node.md | move | INP3 smoothing formula is reference-level; could go to contribute/ax25-stack. |
| packet.md#BBS | run/radios/packet-node.md (connected-mode BBS config) + shack/packet-and-bbs.md (connectionless mail, user view) + shack/messages.md | split | |
| packet.md ### FBB forwarding (+ LZHUF note) | run/radios/packet-node.md | move | "byte-exact against a real F6FBB oracle … tools/interop" → contribute/testing. |
| packet.md#Internet crosslinks | run/radios/packet-node.md | move | |

#### rf-regulatory.md, administration.md, 44net.md, federation.md

| Source#heading | Destination | Action | Note |
|---|---|---|---|
| rf-regulatory.md (operator half) | run/compliance/on-air-stations.md | split | See Shack table for the user half. |
| administration.md#(intro) | run/day-to-day/index.md "Instance admin at a glance" | merge with #Operator-only surfaces | |
| administration.md#Operator identity | reference/secrets.md §"Who is a sysop" (or run/day-to-day/index) | move | Procedure duplicated in first-hour step 4; keep the rule (`requireSysop`, whoami) as reference. |
| administration.md#Machine credentials | reference/secrets.md | merge | |
| administration.md#Enrolling ingest boxes | run/radios/ingest-box.md §"On the gateway" | merge | |
| administration.md#Sessions | reference/secrets.md §Sessions | move | Security reference, not a task. |
| administration.md#Callsign verification (+ ### LoTW) | run/day-to-day/callsign-verification.md | move | 841+ words; the SQL query and DNS proof table are deep but operator-only. LoTW subsection could be its own page. Player side lives in Play/account. |
| administration.md#Cache adoption | run/day-to-day/cache-adoption.md | move | |
| administration.md#Licence registers | run/day-to-day/licence-registers.md | move | cron/systemd examples fine here. |
| administration.md#Operator-only surfaces | run/day-to-day/index.md | move | FBB forwarding / NET/ROM / Ingest & TAK bullets link radios pages. |
| administration.md#Import heritage places | run/day-to-day/import-places.md | move | |
| administration.md#Remote control of your box | run/radios/remote-box.md | merge with shack.md#Remote box | |
| administration.md#Data protection (GDPR / DSGVO) | run/compliance/data-protection.md | move | Overlaps federation#Privacy across the network (tombstones). |
| 44net.md#(intro) | run/networks/44net.md | move | |
| 44net.md#1. Get an address | run/networks/44net.md | move | |
| 44net.md#2. Bring the tunnel up | run/networks/44net.md (owner) | move | helpers#44Net and deployment's by-shape table merge in here. |
| 44net.md#3. Name and identity | run/networks/44net-identity.md | split | 889 words; with #4 and #5 forms the "identity" half. Overlaps federation#Identity on 44Net (TXT format, host=). |
| 44net.md#4. Configure the instance (+ ### TLS on the 44Net name) | run/networks/44net-identity.md | move | |
| 44net.md#5. Verify with the self-check | run/networks/44net-identity.md | move (owner) | first-hour step 9 duplicate. |
| 44net.md#6. Who can reach you | run/networks/44net.md | move | HAMNET paragraph → run/networks/hamnet.md. |
| 44net.md#7. What 44Net does and doesn't give you | run/networks/44net.md (top, as the "what you get" box) | move | Restates intro; place once near the top. |
| 44net.md#Off the internet: what works over HAMNET only | run/networks/hamnet.md | move | Contains stale "tile packs are planned" (offline map exists). |
| 44net.md#Sources | run/networks/44net.md (bottom) | move | |
| federation.md#(intro) | run/federation/index.md | move | Opens "As a player you need none of it" — good audience signpost; keep. |
| federation.md#Joining the network | run/federation/index.md | move (owner) | Absorbs deployment#Sign your feeds. |
| federation.md#Running federation safely | run/federation/index.md | move (owner) | doctor `federation.posture` links this anchor — keep the heading text. |
| federation.md#Identity on 44Net | run/networks/44net-identity.md §"Peers by callsign" | merge | TXT format duplicated with 44net#3; federation keeps a pointer. |
| federation.md#Signed feeds | reference/federation-trust.md (mechanics) + run/federation/index.md §"Rotate your key" (the command) | split | |
| federation.md#Peers and trust (+ ### One row per instance) | run/federation/index.md (trust table) + reference/federation-trust.md (row binding) | split | |
| federation.md#Keeping mirrors fresh | reference/federation-trust.md (gossip, versions, private networks) + run/federation/index.md (manual sync, FED_SYNC_REGION, discovery) | split | Region/page-cap text duplicated in pocket#Federation. |
| federation.md#Reaching firewalled peers | run/federation/hubs-and-relays.md | move | Pocket's home-hub section links here. |
| federation.md#The instance registry | run/federation/hubs-and-relays.md (or index) + reference/federation-trust.md | split | |
| federation.md#Cross-instance corroboration | reference/federation-trust.md (+ a summary in concepts.md) | move | Explanation, not a task; overlaps concepts' trust model. |
| federation.md#Privacy across the network | run/compliance/data-protection.md | merge | |

---

### Overlaps

#### deployment.md × helpers.md × docker.md × first-hour.md

| Topic | Where the text appears | Duplication | Owner |
|---|---|---|---|
| What `setup.sh` asks and writes | docker#Full stack ¶2 ("asks for your callsign, the APRS-IS passcode and filter, how people reach the box, and an RF site call, then writes ADMIN_CALLSIGNS, APP_URL, DOMAIN, APRSIS_*, RF_SITE_CALL + FIRST_PARTY_SITES, INGEST_SECRET, OPERATOR_SECRET and FED_PRIVATE_KEY … re-running it is safe"); first-hour step 1 (same list, same "keeps every value"); deployment#Self-host ("setup.sh writes its whole configuration and asks how people reach it"); helpers#Self-host ("init selfhost runs deploy/setup.sh") | near-verbatim (docker ↔ first-hour) | run/install/self-host-docker.md |
| Start and health check | docker#Full stack code block; first-hour step 2 (same `SOURCE_COMMIT=… docker compose up -d --build` and `curl …/health`); docker#Tunnel step 4 | verbatim | run/install/self-host-docker.md |
| Ingress choices (Caddy TLS / Cloudflare Tunnel / LAN) | deployment#Self-host bullets; docker#Before you start bullets; deployment#Self-host behind Cloudflare; docker#Cloudflare Tunnel ingress; first-hour step 1 parenthetical | paraphrase ×3 | decision → run/choose-a-shape.md; Tunnel/CDN → run/networks/cloudflare.md; Caddy + LAN → self-host-docker / networks/off-grid |
| Off-grid | deployment#Where RF comes in; docker#Off-grid; rf-ingest#Off-grid; deployment#Self-host LAN bullet | same `INGEST_URL=http://localhost:8787/ingest` story ×3 | run/networks/off-grid.md |
| One-time sign-in link | first-hour#Off-grid sign-in (owner text); referenced by docker#Off-grid, deployment#Self-host, 44net#TLS, 44net HAMNET table, administration#Machine credentials; pocket#Run it + #Visitors over https (parallel text) | pocket ↔ first-hour#Visitors paraphrase | run/day-to-day/sign-in-links.md |
| Secrets | deployment#Secrets every deployment sets (table + per-shape bullets) and #Operator scripts; docker#Full stack service table notes; helpers#Rotating a secret; administration#Machine credentials + #Sessions; quickstarts#Before you start ("never put OPERATOR_SECRET or SESSION_SECRET on it"); first-hour "What the Setup page never writes" | 5 places | reference/secrets.md (install pages say only how *their* shape generates them) |
| Backups | deployment#Backups (owner: archive, backup.sh, lifecycle, Pocket, D1 Time Travel); helpers#Backup and restore (archive format, restore steps); docker#Upgrades backups bullet (repeats backup.sh + lifecycle + BACKUP_PRUNE_BUCKET); first-hour step 6 (cron + "run ./backup.sh once"); deployment#Two obligations #2; pocket#Backup + Extras scheduled backup | docker bullet ≈ deployment#Backups; two backup tools described in two places | run/day-to-day/backups.md |
| Updates | docker#Upgrades bullet ("deploy/aprscaching update, or by hand git pull …"); helpers#Update | partial | run/day-to-day/updates.md |
| Federation posture written by the wizard | docker#Full stack ¶3; helpers#Self-host; federation#Running federation safely | docker ¶3 is the only place the wizard flags are documented | run/federation/index.md §"What the installer sets" |
| Signing key | deployment#Sign your feeds; federation#Joining step 1; first-hour step 1 | paraphrase | run/federation/index.md |
| 44Net by shape | deployment#Self-host 44Net table; helpers#Commands by shape (`net44` row); helpers#44Net; 44net#2; pocket#Pocket on 44Net; first-hour step 9 ≈ 44net#5 | the 4 changes `net44 setup` makes appear in helpers#44Net and 44net#2 | run/networks/44net.md (+ 44net-identity.md for the self-check) |
| Ingest box for a remote gateway | docker#The operator RF box; helpers#Ingest box; quickstarts#Before you start; rf-ingest#Enrolling the box; administration#Enrolling ingest boxes | five angles on one task | run/radios/ingest-box.md (gateway side + box side) |
| Operator call confirmation | first-hour step 4; administration#Operator identity (same two commands) | verbatim commands | first-hour (procedure); administration → reference (rule) |
| Cloudflare split cost | deployment#Which shape; deployment#Cloudflare split admonition; same section's last paragraph; helpers#Cloudflare split ("says what the split costs") | 3× on one page | reference/cloudflare-costs.md; install page keeps one admonition |
| Bare metal | deployment#Self-host last ¶; helpers#Bare metal | summary vs full | run/install/self-host-bare-metal.md |
| Desktop | deployment#Desktop; helpers (desktop `init` line, Verified downloads); `deploy/desktop/README.md` | no manual walkthrough at all | run/install/desktop.md (new text from the README) |

**Ownership rule of thumb:** install pages own *how to get it running once*; first-hour owns *what to do after it answers* (shape-neutral); day-to-day owns *recurring* tasks (backup, update, doctor, rotate); reference/secrets owns *what each secret is*; choose-a-shape owns *the decision*.

#### Other overlaps

- **Browser radio forwarding** — my-radio#Send what you hear ≈ pocket#Your radio in the browser (signed vs secret, tier C). Owner: shack/my-radio.
- **Rig control** — my-radio#Rig control vs rig-weather#CAT rig control (they link each other). Owner: shack/rig-weather.
- **Remote box** — shack#Remote box, administration#Remote control of your box, deployment#Operator scripts "Remote boxes are paired". Owner: run/radios/remote-box.
- **MeshCom** — meshcom.md (owner), pocket#A MeshCom node, rf-ingest#Transports row + warning, quickstarts#MeshCom, docker#RF hardware (port 1799 publishing), meshcom#Firewall. Trust table repeated in rf-ingest warning and pocket.
- **Tier A receiving site** — rf-ingest#Receiving site (owner), quickstarts KISS step 6 and IGate step 3, first-hour step 7, pocket#A USB TNC, meshcom#How trusted, concepts.md#transport-is-not-trust.
- **AXUDP/AXIP** — quickstarts#AXUDP, rf-ingest#Transports rows, packet#Internet crosslinks, rf-ingest#AXUDP over 44Net, docker#RF hardware (CAP_NET_RAW).
- **BBS** — shack#BBS, node and forwarding (pointer), packet#BBS (both surfaces).
- **On-air compliance warnings** — rf-ingest#On-air legality, packet warning, quickstarts IGate/Digipeater, my-radio#Transmit, meshcom#Answering, pocket#USB TNC TX. All point at rf-regulatory; after the split the user-TX ones point at shack/on-air, the automatic-station ones at run/compliance/on-air-stations.
- **44Net identity** — federation#Identity on 44Net (TXT format, adding by callsign, DNSSEC fallback) vs 44net#3 (record table, worked example) vs administration#Callsign verification (ampr_dns proof). Owner: run/networks/44net-identity; verification keeps its proof table.
- **Pocket federation** — pocket#Federation: sync before a trip and ### Your home instance as the hub vs federation#Keeping mirrors fresh (FED_SYNC_REGION, page caps) and #Reaching firewalled peers (push-to-hub, backoff 30 s→10 min, FED_SPOKE_STALE_HOURS). Same numbers in both.
- **Privacy/GDPR** — administration#Data protection vs federation#Privacy across the network (tombstones). Owner: run/compliance/data-protection.
- **Weather** — rig-weather#Weather stations (user + sysop + API mixed).

#### Stale or wrong content found while reading

- 44net.md HAMNET table: "Instance-served tile packs are planned" — offline-map.md documents them as built.
- AdminPanel "About the write budget" opens `operate/deployment`, but the write budget is `reference/cloudflare-costs.md#write-budget`.
- `.env.example`, `deploy/.env.example`, `workers/gateway/wrangler.toml` and `tools/config/envfiles.mjs` cite `docs/operate/deployment.md "Cost on D1"` / `"Write budget"`; those headings exist only in `docs/reference/cloudflare-costs.md`.
- deployment.md#Three ways to deploy omits Pocket and bare metal from its table.
- packet.md "behaviour on a real radio is validated at deploy, as tracked in TODO.md" and rig-weather "a companion … is planned" — forward-looking; fine per the rules (TODO pointer), but they read like project status in a how-to.

---

### Splitting the Pocket page

pocket.md = 5,484 words. Section word counts: intro 183 · What it is 106 · Install 569 · Run it 133 · Keep it running 123 ·
Extras 684 · Browsers 132 · Visitors over https 197 · MeshCom node 266 · USB TNC 397 · RTL-SDR 216 · Radio in browser 161 ·
Reaching from internet 103 · Pocket on 44Net 599 · Federation/sync (+hub, +lost phone) 858 · Backup 75 · Troubleshooting 350 ·
Tested on 165 · Alternatives 82.

| New page | Title | Takes | ≈ words |
|---|---|---|---|
| run/install/pocket.md | Install Pocket on an Android phone | intro + diagram, What it is and isn't, Install (incl. setup questions table), Browsers on the phone, Tested on (phone table only), Alternatives + RTL-SDR "not supported" table | ~1,350 |
| run/pocket/field-station.md | Run Pocket in the field | Run it, Keep it running, Visitors over https (commands; the security model links day-to-day/sign-in-links), A MeshCom node, A USB TNC on the phone, Your radio in the browser (2 lines → shack/my-radio), Backup (2 lines → day-to-day/backups#pocket), Troubleshooting | ~1,450 |
| run/pocket/extras.md | Pocket extras | Extras: add-on table, every-extra table, notification, shortcuts, battery saver, field alerts, position, scheduled backup | ~700 |
| run/pocket/44net.md | Reach Pocket from outside (Cloudflare, 44Net) | Reaching it from the internet, Pocket on 44Net (incl. ampr-cert.sh) | ~700 |
| run/pocket/trips.md | Before a trip: sync and your home hub | Federation: sync before a trip, Your home instance as the hub (phone side; hub side → run/federation/hubs-and-relays), If the phone is lost | ~850 |
| contribute/testing.md (append) | — | Tested on: the `pocket-termux` CI paragraph; USB bridge prior-art paragraph | ~120 |

Cross-page duplicates removed in the split: "Your radio in the browser" (→ shack/my-radio), "Backup" (→ day-to-day/backups), MeshCom trust rule (→ run/radios/meshcom), hub mechanics (→ run/federation/hubs-and-relays), visitor sign-in safety (→ day-to-day/sign-in-links).

Script references to update: `deploy/pocket/pocket.sh:44,86,141`, `deploy/pocket/update.sh:57` → run/install/pocket.md;
`deploy/pocket/extras/usb_kiss_bridge.py:282` (compatibility table) → run/pocket/field-station.md;
`deploy/pocket/README.md:268` (`pocket.md#pocket-on-44net`) → run/pocket/44net.md; `.github/workflows/pocket-termux.yml:5` → contribute/testing or run/install/pocket.

---

### Troubleshooting, built from the doctor checks

Source: `deploy/lib/doctor.sh` (`run_doctor`: config → gateway → setup → ingest → network → federation → net44 → shape extra → resources → source) and
`deploy/lib/shapes/{selfhost,baremetal,ingest-box,cloudflare}.sh` (`shape_doctor_extra` / `shape_doctor_context`). Pocket and Desktop add no checks of their own.
helpers.md#doctor's group table lacks `net44.*` and `service.*` per-shape detail — the troubleshooting page should list them.

Proposed page: **run/troubleshooting.md "Troubleshooting"** — one H2 per doctor group, one H3 per check id (so `see:` can link `#gateway-reachable` etc.), each with: what it tests · what the message means · the fix · the doc section that explains it. Pocket's own symptom table and meshcom#Troubleshooting stay on their pages and are linked from a final "Not from doctor" section.

| Check id | Status | Tests | Fix printed | Doc section that explains the fix (target) |
|---|---|---|---|---|
| `config.file` | fail | the shape's `.env` exists | `deploy/aprscaching init <shape>` | run/install/<shape> |
| `config.permissions` | fail | `.env` mode is owner-only | `chmod 600` | reference/secrets |
| `config.value.<KEY>` | fail | each value fits its type in the config schema | correct it | reference/configuration (+ "Settings are checked at start") |
| `config.values` | pass | all values typed | — | — |
| `config.unknown` | warn | keys not in the schema (typos) | check names | reference/configuration |
| `config.secrets` | fail | INGEST/OPERATOR/SESSION/FED_SUBMIT/FED_RELAY/FED_CORROBORATION secrets not weak, example or < 16 chars | `rotate-secret <name>` | reference/secrets §Rotation |
| `config.ingest_secret` | fail | INGEST_SECRET set (or BOX_KEY), except Desktop | `init <shape>` | reference/secrets |
| `config.public` | warn | public instance sets the shape's required keys (`cfg_keys_for … 1`) | set them | run/first-hour §public-ready, run/compliance |
| `config.api` | fail | Cloudflare: Worker URL known (`APRSCACHING_API_BASE`) | set it | run/install/cloudflare-split |
| `config.ingest_url` | fail | ingest box: INGEST_URL set | set it | run/radios/ingest-box |
| `gateway.reachable` | fail | `/health` answers, and as the gateway (has `db`), not the SPA | `status`; logs / proxy routes `/health,/api/*,/ingest,/.well-known/*` | run/install/<shape> §What runs; networks/cloudflare (proxy) |
| `gateway.database` | fail | `/health` reports db up | check data dir, logs | run/install/<shape> |
| `gateway.migrations` | warn | `/health` schema = newest `db/migrations/*.sql` | restart / update checkout | run/day-to-day/updates |
| `gateway.version` | warn | running commit = checkout HEAD | `update` or restart | run/day-to-day/updates |
| `setup.checklist` | warn | OPERATOR_SECRET present and `/api/admin/setup` returns items | set OPERATOR_SECRET / open Instance admin → Setup | run/first-hour |
| `setup.<item>` | pass/warn/fail (blocking ⇒ fail) | each Setup checklist item; Cloudflare adds `setup.budget` (D1 writes) | Instance admin → Setup | run/first-hour (per item); reference/cloudflare-costs#write-budget for `budget` |
| `ingest.credentials` | fail/warn | `GET /ingest/check` accepts INGEST_SECRET or the signed box key; detects proxy, 401 (revoked/wrong), 404 (old gateway) | copy secret / enroll again / check INGEST_URL / update gateway | run/radios/ingest-box (enroll), reference/secrets |
| `ingest.aprsis` | warn | TCP to APRSIS_HOST:PORT (default rotate.aprs2.net:14580) | check network / APRSIS_HOST | run/radios/quick-starts#aprs-is; networks/hamnet (APRSIS_HOST on HAMNET) |
| `ingest.kiss_tnc`, `ingest.agwpe`, `ingest.hostmode`, `ingest.meshtastic` | fail | TCP to each configured `<NAME>_HOST:PORT` | check device and host/port | run/radios/quick-starts (per link); rf-ingest#from-a-container (Docker `localhost`) |
| `ingest.meshcom_bind` | warn | `MESHCOM_BIND=0.0.0.0` on a public host | bind LAN address | run/radios/meshcom §Optional settings, §Firewall |
| `ingest.meshcom.<CALL>` | warn | node `=CALL` heard recently (`/api/meshcom/nodes`) | check ExtUDP settings | run/radios/meshcom §1, §Troubleshooting |
| `ingest.meshcom_fw.<CALL>` | warn | firmware ≥ 4.35t | update firmware | run/radios/meshcom §What you need |
| `ingest.url` | fail | bare metal: INGEST_URL not `http://gateway:*` | set to local base | run/install/self-host-bare-metal |
| `network.dns` | fail | public host resolves | DNS record / tunnel hostname | run/install/self-host-docker; networks/cloudflare |
| `network.tls` | fail/warn | TLS cert on :443 present, not expired, > 14 days | Caddy / tunnel / proxy; renew | run/install/self-host-docker (Caddy); networks/cloudflare |
| `network.route` | fail | public `/health` answers with this instance+commit | point DNS/tunnel here; check proxy & firewall | networks/cloudflare; install/self-host-docker §Before you start (ports) |
| `federation.off` / `federation.lan` | pass/warn | LAN instance has no FED_PEERS/FED_HUB_URL | remove FED_PEERS (fine on HAMNET) | run/federation/index; networks/hamnet |
| `federation.key` | warn | FED_PRIVATE_KEY set | `genkey.mjs --raw` | run/federation/index §Sign your feeds |
| `federation.posture` | warn (one per issue) | FED_DISCOVER off; FED_AUTO_PROMOTE 0; quorum ≥ 2; peers https; no 44Net peer in FED_PEERS; hub has FED_SUBMIT_INSTANCES; registry has FED_REGISTRY_KEY | see Running federation safely | run/federation/index#running-federation-safely |
| `federation.peer.<host>` | warn | each FED_PEERS `/.well-known/aprscaching` answers | check URL / ask operator | run/federation/index |
| `net44.tunnel` | fail/warn | wg44 up with handshake ≤ 180 s; or FED_ENDPOINTS names a 44net host but wg44 down | `net44 status` / `net44 setup` | run/networks/44net §Bring the tunnel up |
| `net44.mtu` | warn | wg44 MTU ≤ cap (1420) | `net44 setup` | run/networks/44net §Bring the tunnel up (MTU) |
| `net44.firewall` | warn | nft table on wg44 present | `net44 setup` or own filter | run/networks/44net §Who can reach you |
| `net44.dns` | fail | 44Net name has an A record matching the tunnel's address | fix in 44Net Portal | run/networks/44net-identity §Name and identity |
| `net44.txt` | fail | `_aprscaching` TXT published | publish value from Setup → 44Net | run/networks/44net-identity §Name and identity |
| `net44.cert` | warn | cert for the 44Net name (when in DOMAIN) valid > 14 days | Caddy renewal | run/networks/44net-identity §TLS on the 44Net name |
| `service.gateway`, `service.ingest`, `service.caddy`, `service.cloudflared` | fail | Self-host: containers running (cloudflared when TUNNEL_TOKEN) | `status`; `docker compose logs <svc>` | run/install/self-host-docker §What runs |
| `service.docker` | fail | Self-host: docker installed | install Docker / `--shape` | run/install/self-host-docker §Before you start |
| `service.gateway_port` | warn | gateway 8080 not published past Caddy | remove `ports:` | run/install/self-host-docker (Open only what the stack needs) |
| `service.meshcom_port` | warn | 1799/udp not published on all addresses of a public host | publish on LAN address | run/radios/rf-ingest §From a container; run/radios/meshcom §Firewall |
| `service.aprscaching-gateway`, `service.aprscaching-ingest` | fail | bare metal: units active | `systemctl enable --now`; journalctl | run/install/self-host-bare-metal |
| `service.ingest` | fail | ingest box: container running | `docker compose -f compose.ingest-only.yml up -d` | run/radios/ingest-box |
| `pages.app` / `pages.api_base` | fail | Cloudflare: Pages app answers and was built with this Worker's `VITE_API_BASE` | deploy Pages / rebuild | run/install/cloudflare-split |
| `resources.disk` | fail/warn | data disk < 98 % / < 90 % and ≥ 1 GiB free | free space | run/day-to-day (new "Disk and database size" note) |
| `resources.database` | pass | reports DB size | — | — |
| `resources.backup` | fail/warn/pass | a backup destination is set; newest backup (dir, bucket via `oci`) ≤ `APRS_BACKUP_MAX_DAYS` (7); Cloudflare always passes (Time Travel) | `backup` and schedule; `systemctl status aprscaching-backup.timer` (OCI) | run/day-to-day/backups |
| `resources.backup_place` | warn | archives only on this host's disk | set BACKUP_DIR elsewhere | run/day-to-day/backups |
| `source.link` | fail/warn | `/.well-known/source` answers with repo and commit | make public; rebuild with SOURCE_COMMIT | run/compliance/index §Source (AGPL §13) |
| `source.fork` | warn | local changes but SOURCE_REPO is upstream | publish fork, set SOURCE_REPO | run/compliance/index §Source |

Outline of run/troubleshooting.md:

```
# Troubleshooting
  Run the doctor first (deploy/aprscaching doctor; --json; exit status; never prints secrets)
  How to read a result (pass/warn/fail, fix:, see:)
- config      (file, permissions, value.<KEY>, unknown, secrets, ingest_secret, public, api, ingest_url)
- gateway     (reachable, database, migrations, version)
- setup       (checklist, <item>, budget)
- ingest      (credentials, aprsis, kiss_tnc/agwpe/hostmode/meshtastic, meshcom_bind, meshcom.<CALL>, meshcom_fw.<CALL>, url)
- network     (dns, tls, route)
- federation  (off/lan, key, posture, peer.<host>)
- net44       (tunnel, mtu, firewall, dns, txt, cert)
- service     (docker, gateway/ingest/caddy/cloudflared, gateway_port, meshcom_port, systemd units, ingest box)
- pages       (app, api_base)
- resources   (disk, database, backup, backup_place)
- source      (link, fork)
- Not from doctor
   Radio in the browser → shack/my-radio#troubleshooting
   MeshCom log messages → run/radios/meshcom#troubleshooting
   Pocket on the phone  → run/pocket/field-station#troubleshooting
   Ingest box log lines ([forward] gateway unreachable, [axip] disabled …) → run/radios/quick-starts
```

Headings should be the check ids written as words (e.g. `### gateway.reachable`) so MkDocs anchors are predictable (`#gatewayreachable` — check the slugifier; dots are dropped by the default `toc` slugify). Consider giving doctor a `see:` of `docs/run/troubleshooting.md#<id>` for every check, replacing today's scattered links.

---

## Move map — Reference and Contribute

Destination folders: `docs/reference/` (stays) and `docs/contribute/` (new; `style-guide.md` already exists
there). Design notes go to `docs/contribute/design/` keeping their file names, so each slug changes only in its
prefix. "Inbound" = the per-page totals from the census below (all forms, nav included).

#### Reference (target: API, configuration, CLI, federation wire, MeshCom ExtUDP, data model, licence registers, costs)

| current path | destination | action | inbound | note |
|---|---|---|---|---|
| `docs/reference/api.md` | `docs/reference/api.md` | keep | 8 (5 intra-docs) | Route catalogue. "Admin / sysop", "Remote box", "Ingest & BBS backend" and "Scheduled tasks" are operator-facing but are route/timer listings — they stay. External: README published URL `reference/api/`. |
| `docs/reference/configuration.md` | `docs/reference/configuration.md` | keep | 28 (13 intra-docs) | **Key tables are generated** (`tools/config/generate.mjs`, `CONFIG_MD = "docs/reference/configuration.md"` hardcoded at line 72) from `packages/shared/src/configdocs.ts`, whose 13 links are written **relative to `docs/reference/`** — 9 of them point at `../operate/…` (`first-hour`, `administration` ×2, `rf-regulatory` ×4, `deployment`): when `operate/` moves to `run/`, edit `configdocs.ts` and regenerate; never hand-edit the tables. Path is also named by `servers/node/src/server.ts:52`, `apps/ingest/src/index.ts:22`, `deploy/lib/doctor.sh:91/97/98`, `workers/gateway/src/env.ts:10`, `packages/shared/src/config.ts:7`, `.claude/rules/docs-and-comments.md`, and `tools/checks/docs.mjs` check 2 depends on the page — keeping the path avoids all of them. Operator content inside: "Deploy scripts" section (fine as reference). |
| `docs/reference/cli.md` | `docs/reference/cli.md` | keep | 13 (5 intra-docs) | Hard path dependencies: `.github/workflows/ci.yml:48` (path filter that triggers the deploy-helpers job) and `deploy/test/helpers-test.sh:439/446` (test reads the file and asserts every option is documented). **Contributor content inside:** "Development & conformance" (a pointer to `testing.md`) → relink to `../contribute/testing.md`; the note on `tools/teaser/` and `tools/webauthn/` is contributor material → move to Contribute/Run from source or Architecture. |
| `docs/reference/cloudflare-costs.md` | `docs/reference/cloudflare-costs.md` (nav label "Costs" or "Cloudflare D1 costs") | keep (do not rename) | 9 (5 intra-docs) | This is the "costs" item. Inbound includes `configdocs.ts:436/446` and `deploy/lib/shapes/cloudflare.sh:30`; renaming to `costs.md` buys nothing under G4. **Operator content inside:** "Write budget" tells the operator what to set on Workers Free — acceptable as reference; Run → Cloudflare split must link here. **Stale pointers to fix:** `.env.example:93/101`, `deploy/.env.example:58/67`, `tools/config/envfiles.mjs:105/113/262/271`, `workers/gateway/wrangler.toml:41/45` say `docs/operate/deployment.md "Cost on D1"` / `"Write budget"` — both sections live in **this** page (deployment.md has neither heading). |
| `docs/reference/data-model.md` | `docs/reference/data-model.md` | keep path; **move nav** from "Develop & contribute" to Reference | 2 (0 intra-docs) | **Contributor content inside:** the first paragraph's rule "a schema change is a new next-numbered file; an applied file is never edited" belongs in Contribute (Architecture / Run from source). **Operator content inside:** "the durable record is caches, finds, accounts and keys — back those up" → Run → Backups should own it (link here for the table list). |
| `docs/reference/federation-wire.md` | `docs/reference/federation-wire.md` | keep | 8 (4 intra-docs) | "44net verified onboarding" is the DNS TXT wire format (reference) but its how-to side belongs to `run/44net.md` (already there: keep this page format-only). "Store-and-forward over FBB" and "Connected-mode sync" are format; their operator setup is in packet/federation guides. External: README published URL, TODO.md:751. |
| `docs/reference/meshcom-extudp.md` | `docs/reference/meshcom-extudp.md` | keep | 9 (6 intra-docs) | **Operator content inside:** "Node setup" (`--setssid`, `--extudpip`, `--extudp on`) is an operator procedure duplicating `operate/meshcom.md` → move it to `run/meshcom.md` and leave a link. "Differences from the ICSSW description" and "Firmware versions" are spec/contributor material but fit a protocol reference. Named by `packages/aprs/src/meshcom/parse.ts:4` (path unchanged). |
| `docs/reference/licence-sources.md` | `docs/reference/licence-sources.md` | keep | 6 (5 intra-docs) | **Contributor content inside:** "Adding a register means adding one module under `tools/licence/sources/`…" → Contribute (or keep one line linking to the code). **Operator content inside:** "Attribution" is an obligation on the instance operator → Run/Administration should link to it. Import commands are in `cli.md#licence-registers`. |
| `docs/reference/specs.md` | `docs/contribute/specs.md` | **move** | 2 (0 intra-docs) | Pure contributor reference (what was implemented from which open spec — the IP rule). Relative links inside (to `../operate/…`, etc.) must be re-based. |
| `docs/reference/testing.md` | `docs/contribute/testing.md` | **move** | 9 (5 intra-docs) | Contributor page ("CI guards", "CI map", interop). External inbound: README.md:61 published URL `reference/testing/`, `CONTRIBUTING.md:54`, `cli.md` "Development & conformance", `contribute/style-guide.md:114/146`, vite-docs NAV. Its CI-map row for `docs.yml` must be kept in step with the new checks. |

#### Contribute (target order: Run from source → Architecture overview → Testing → Design notes → Style guide → Specs)

| # | current path | destination | action | note |
|---|---|---|---|---|
| 1 | `docs/getting-started.md` | `docs/contribute/run-from-source.md` | **move + rename** (title is already "Run from source") | Heaviest external inbound of the set: README.md:38 and :59 (published URL `getting-started/`), vite-docs NAV ("Getting started" in Overview — stale label). **Operator content inside:** the intro addresses "operators who want to run from a checkout"; "Add RF ingest (optional)" is operator material → link to `run/rf-ingest.md` instead of explaining. "Where to next" links (concepts, deployment, configuration) re-base. |
| 2 | — (new) | `docs/contribute/architecture.md` | **create** | One Mermaid diagram: `apps/web` SPA + `apps/ingest` → gateway `handle()` (`workers/gateway/src/app.ts`) → three runtimes (Worker+D1/R2/DO · Node+better-sqlite3 · Bun+`bun:sqlite`/desktop) with `servers/*` shims, `db/migrations` shared, `packages/*` (MIT) underneath. Source material: CLAUDE.md "Architecture: one gateway, three runtimes", INDEX.md layout, `data-model.md`'s migration rule, `cli.md`'s `tools/teaser`/`tools/webauthn` note. |
| 3 | `docs/reference/testing.md` | `docs/contribute/testing.md` | **move** | see Reference table. |
| 4a | `docs/design/design-language.md` | `docs/contribute/design/design-language.md` | **move** | Self-declared contributor page ("for people who build or review the web app; the operator and player guides never need it"). Named by code comments `apps/web/src/styles/tokens.css:108`, `apps/web/src/ui/Icon.tsx:3`, `apps/web/src/demo/UiKit.tsx:6`, an **in-app link** `UiKit.tsx:479` (`/?view=docs&doc=design/design-language`), and a relative link in `.claude/rules/ui-ux.md:8`. |
| 4b | `docs/design/meshcom.md` | `docs/contribute/design/meshcom.md` | **move** | Its "Built and planned" admonition is operator signposting (→ `run/meshcom.md`) — fine. Named by `packages/aprs/src/meshcom/normalize.ts:5` and TODO.md:539/558 (with `#via-calls`). |
| 4c | `docs/design/radio-find-logging.md` | `docs/contribute/design/radio-find-logging.md` | **move** | **Player content inside:** the "Commands" table (`FOUND`/`DNF`/`NOTE`/`HELP`/`VERIFY`) is what a player sends — already duplicated for players in `guides/caching.md:132` (and `guides/offline.md:51`, `operate/meshcom.md:66`); the design page should link to the Play page rather than be the canonical command list. TODO.md:546/573. |
| 4d | `docs/design/meshcom-tdeck-map.md` | `docs/contribute/design/meshcom-tdeck-map.md` | **move** | Research note, nothing built; no audience mixing. TODO.md:568. |
| 5 | `docs/contribute/style-guide.md` | (already in place) | keep | Added in this phase; its nav entry sits under "Develop & contribute". It links `../play/index.md` (line 60), which does not exist yet, inside the page-template code block, so it is not a live link. Also `../reference/testing.md` ×2 (lines 114, 146) → becomes `testing.md`. |
| 6 | `docs/reference/specs.md` | `docs/contribute/specs.md` | **move** | see Reference table. |
| — | — | `docs/contribute/index.md` (optional) | create if the section wants a landing page | Material `navigation.sections` does not need one; the in-app reader opens a page, so a landing page is optional. |

Pages outside this task's scope that Reference/Contribute pages link to (re-base when they move):
`operate/*` → `run/*`, `guides/*` → `play/*` or `shack/*`, `glossary.md` and `about.md` presumably stay at the
root (Glossary, About); `concepts.md`, `start-here.md` and `index.md` are placed by the Play/root work.

## Gaps: the game as the code has it

Every game feature, checked in the code, against what the manual says. This is the source for the Play pages
and the cache-type pages in Phase 3; nothing in them is to be invented.

Line refs are `path:line` at HEAD. "Docs" = current page/anchor.

| Item | Code says (evidence) | Documented where | Gap |
|---|---|---|---|
| Cache types — full list | 10 types: `traditional, multi, aprs_living, audio, virtual, sota, pota, wwff, bunker, castle` (`packages/shared/src/dto.ts:4-15`). Labels/help/glyphs per type (`apps/web/src/cacheTypes.ts:15-41`). | `guides/caching.md#cache-types` (one table) | No per-type detail; map marker glyphs (●, Ⓜ, ✦, ♪, ◇, ▲, ❂, ❀, ▣, ♜; Phosphor variants) undocumented. |
| Which types are hideable | Hide UI offers `TYPE_ORDER` = traditional, multi, aprs_living, audio, virtual, **sota, pota** (`apps/web/src/cacheTypes.ts:43`, `apps/web/src/caches/HidePanel.tsx:189`). API accepts all 10 for any signed-in user (`dto.ts:84-103`, `workers/gateway/src/caches.ts:338-390`). wwff/bunker/castle are missing from the hide list, the map filter (`FilterPanel.tsx:74`) and the offline-pack type filter (`OfflinePanel.tsx:413`). | not documented | Docs should say heritage types come from imports; code inconsistency → Known issues. |
| Which types are loggable | `handleLog` has no type, source or status check (`caches.ts:467-599`); detail panel always renders `LogForm` (`DetailPanel.tsx:302`). Mirrored (remote) caches are read-only: "Log your find on its home instance" (`RemoteCachePanel.tsx:6,32`). | partially (`caching.md#log-a-find`) | Not stated that imported/heritage caches are loggable and score points/badges; not stated remote caches log at home. |
| Type-specific verification | `aprs_living` → Tier A matched against the station's positions (`verify.ts:185-208, 248`); all other types → cache pin (`verify.ts:170-182`). Tier B always uses cache lat/lon (`verify.ts:211-232`). | no | Per-type "what found means" missing. |
| Stages: unlock kinds | `geo | audio | open | nfc`, invalid → `geo` (`stages.ts:121`; `dto.ts:250`). Stage 0 is the public start (`stages.ts:3-5,199`). Next stage unlocks only after the previous one (`stages.ts:233-236`). | `caching.md#staged-caches` (3 bullets) | Ordering rule, stage 0, what each reveals missing. |
| Stages: geo radius | `radius_m` default **60** (`stages.ts:134`; `0001_baseline.sql:276`). Geo unlock checks distance to the **previous** stage's position against the previous stage's radius (`stages.ts:239-249`). | no | Docs say "standing at the current stage"; radius not given. |
| Stages: audio/open | Unlock "on request"; the audio clue is advisory (`stages.ts:258`). Audio clue upload: owner, `audio/*`, ≤5 MB (`stages.ts:155-174`); served publicly (`stages.ts:177-184`). | `caching.md#staged-caches` ("follow the clue, then Reveal") | Docs should say plainly that audio/open are honour-system. |
| Stages: NFC | `unlock_secret` compared trim+casefold (`stages.ts:27,251-257`); WebNFC scan or typed code. Never returned by read endpoints (`0001_baseline.sql:266-267`). | `caching.md`, `offline.md#out-there` | OK for players. |
| Stages: offline sealed NFC | Sealed with PBKDF2-SHA256 100 000 rounds + AES-GCM only if code ≥ **40 bits** entropy (`packages/shared/src/stageseal.ts:17,19,46-52,72-112`; `stages.ts:58-87`; `0011_stage_sealed.sql`). Geo stages never offline. | `offline.md#out-there` ("nine or more random letters and digits") | Covered; hider-side advice ("use the tag serial") belongs on `hide-a-cache.md`. |
| Stages: how a hider sets them | Only `POST /api/caches/:id/stages` (`stages.ts:90-152`); `setStages` in `apps/web/src/api.ts:1188` has no caller — **no UI**. | `caching.md#hide-a-cache` (API paths) | Player page cannot point to an API; needs an honest "ask your sysop / not in the app yet" or a UI. |
| Stage media key / unlocks ledger | `media_key` per stage; `stage_unlocks(callsign, cache_id, stage_no)` (`0001_baseline.sql:268-288`).  | no | Reported to the owner. |
| Multi: what "found" means | Find is not gated on unlocking stages; verified against the cache's own lat/lon (`caches.ts:467-599`, `verify.ts:170-182`). Schema calls cache lat/lon "final coordinates (stage 0 of a staged cache)" (`0001_baseline.sql:228`) while `stages.ts:3` calls stage 0 "the published start". | no | Undefined in docs; code is ambiguous → Known issues. |
| Living cache: station_call | `stationCall` free text on create/update (`dto.ts:92,116`; `HidePanel.tsx:199-204`). Safer paths: "become a cache" from own beacon (`stations_mine.ts:315-345`) and station→cache for an owned station (`stations_mine.ts:286-312`). | `caching.md#hide-a-cache` (one sentence), glossary | No player explanation of finding (be co-located with the station). |
| Living cache: matching window | Tier A needs an attested, independently gated logger fix within **150 m** of the station's fix nearest in time, skew ≤ **5 min** (`verify.ts:39-41,185-208`); window 30 min (`verify.ts:40`). | no | Values undocumented. |
| Living cache: map position | Cache `lat/lon` is set at creation and never updated by ingest (no `UPDATE caches SET lat` anywhere; grep). | no | Map shows the pin where it was hidden, not where the station is → Known issues. |
| Rendezvous | Opt-in per living cache (`dto.ts:102`; `HidePanel.tsx:205-206`). Two opted-in living caches within **150 m**, both heard within **15 min**, de-duplicated per pair for **1 h** (`rendezvous.ts:12-14,24-64`); stored in `rendezvous_log` with lat/lon (`0001_baseline.sql:346-359`); last 10 shown on the cache page (`rendezvous.ts:75-87`; `DetailPanel.tsx:286-290`). No points (`rendezvous.ts:5-6`). Exported/erased (`account.ts:264-266,455`); no retention pruning. | `caching.md#community` (one sentence, correct values) | Move to `living.md`; mention it is shown publicly with place and time. |
| Log types | `found, dnf, note, maintenance, enabled, disabled` (`dto.ts:31`). Only `found` is verified (`caches.ts:551-568`). UI offers found, DNF ("Couldn't find it"), note, and maintenance for the owner (`LogForm.tsx:211,227,241,247`). `enabled`/`disabled` are never posted by the UI; the API accepts all six from any signed-in user (`caches.ts:467-484`). | `caching.md#log-a-find`, glossary (find/DNF/note) | Maintenance log undocumented for players (only in offline.md); enabled/disabled unexplained. |
| One find per … | App: unique on `(cache_id, logger_call)` (`0001_baseline.sql:316`; `caches.ts:532-549`) — per exact call string incl. SSID; a session may log as any SSID of its own base call (`caches.ts:479`). Radio: once per person across SSIDs and account calls (`radiolog.ts:338-351`). | `caching.md#log-a-find` ("one find from each callsign") | Inconsistent rule → Known issues. |
| Distance confirm | Client asks before logging when the device reading is farther than it can verify (`LogForm.tsx:95-106`). | `caching.md#log-a-find` | Covered. |
| Offline queue | Queued logs; 5xx/408/429 retried with backoff; other 4xx → "Needs attention" with reason, retry/edit comment/discard (`apps/web/src/log/logQueue.ts:7-10,61,129,154,174`); panel "Logs to sync" (`OutboxPanel.tsx:88-218`); status line "N logs waiting · N needs attention · pack … old" (`offline/syncEngine.ts:55-60`). Background Sync tag `acs-logqueue` (`apps/web/public/sw.js:186-190`). | `offline.md#back-online`, `#out-there` | Covered; needs a short version in `log-a-find.md`. |
| Field time of an offline find | Signed time accepted if ≤60 s in the future, ≤7 days old, after cache creation and after the device key's registration; else receive time with a reason (`workers/gateway/src/fieldtime.ts:18-23,48-56`; `retention.ts:42`; `0008_field_time.sql`). | `offline.md#back-online` | Covered accurately. |
| Radio logging | `FOUND/DNF/NOTE <code> [text]`, `HELP`, `VERIFY` (design `docs/design/radio-find-logging.md`). Needs a control-verified call (`radiolog.ts:416-418`). Trusted (heard at attested site, or signed browser batch) → logged; else pending, confirm in app, expires after **7 days** (`radiolog.ts:53,433-440,529`). **10** commands/hour per base call (`radiolog.ts:47,388`). Retries within 30 min re-acked only (`radiolog.ts:57,375-385`). Scored at message time; Tier A or C, never B (`radiolog.ts:425`). | `caching.md#log-from-your-radio` | Covered. Player page should state the 30-minute window before the message. |
| "Queued" / "needs attention" states | Result card "Saved — offline, will sync…" (`LogForm.tsx:147-151`); needs-attention group (`OutboxPanel.tsx:93`); radio "Logs sent over the air" pending list (`apps/web/src/profile/RadioLogs.tsx`). | `offline.md` | Covered. |
| Verification tiers | A: attested, independently gated RF fix within **150 m**, plausible track ≤300 km/h, 30-min window (`verify.ts:37-45,170-182`), or peer corroboration (`caches.ts:697-723`). B: device reading within 150 m + accuracy (accuracy clamped to 200 m), reading within ±**120 s** of log time (`verify.ts:211-232`). C: an APRS-IS fix within 150 m, or nothing (`verify.ts:257-273`). | `caching.md#log-a-find`, `start-here.md`, `concepts.md` | Numbers (150 m, 30 min, ±2 min) not in player docs; three overlapping explanations. |
| Minimum tier / min_trust | Site default `B` is a **hard-coded constant** (`verify.ts:38`), no config key (grep finds none). Per cache `min_trust` A or B only (`dto.ts:25`); a find below it keeps its tier, `verified=false`, reason "cache requires tier X" (`verify.ts:251-255`); UI text "on record but does not count as verified" (`LogForm.tsx:34-36`). Owner can raise it only via API; cannot clear it back to the site default (`caches.ts:419`, `MinTrust` has no null). | `concepts.md` ("Each instance sets a minimum accepted tier"); `caching.md` ("recorded as Logged") | concepts.md claims an instance setting that does not exist; caching.md mislabels the outcome. |
| Difficulty / terrain | 1–5, default 1.5 (`dto.ts:36,89-90`), UI step 0.5 (`HidePanel.tsx` sliders). Feed points (`community.ts:19-20`). | `caching.md` ("1–5") | Step and default and scoring effect missing. |
| Hint | ≤500 chars (`dto.ts:92`); never federates (`workers/gateway/src/federation.ts:82-97`); included in offline packs (`offlinepack.ts:262`); revealed by tap. | `caching.md#hide-a-cache` ("The hint is never shared") | Covered. |
| Description, drive-in, country, tags | Description ≤4000; tags ≤12 × ≤24 chars, lowercased/deduped; country ≤56 (`dto.ts:71,93,98-100`; `caches.ts:120-128`). | `caching.md#hide-a-cache` (names only) | Limits and meaning (tags are not searchable/filterable in UI — not verified) missing. |
| Cache media | Owner only; ≤20 items, ≤10 MB each, image/audio/file; thumbnail ≤150 kB JPEG/WebP (`stages.ts:276-356,359-390`); public list (`stages.ts:284`). | `caching.md#hide-a-cache` (photo scaling) | Limits missing. |
| Ratings | 1–5 stars, upsert per callsign (`dto.ts:78-81`; `community.ts:304-326`). Policy `finders` (a **verified** find by that exact call) / `all` (any signed-in) / `off` (`community.ts:270-279`; UI labels "Finders only / Anyone signed in / Nobody" `HidePanel.tsx:268-276`). | `caching.md#community` ("rate caches you found"), hide "who may rate" | Policy values and "verified find" requirement missing. |
| Favourites | Toggle; count shown (`community.ts:212-237,328-342`).  | `caching.md#community` (one bullet) | Reported to the owner. |
| Watches | Two different things: per-cache `watches` table (`community.ts:238-242`; `0001_baseline.sql:411`) — **no UI caller and nothing reads it** except export/erase (`account.ts:159,410`); the real watchlist watches **callsigns** with in-app/push/email alerts (`watch.ts:1-12`). Owner gets a `cache_found` alert on each find (`caches.ts:791-803`). | `account.md#settings-at-a-glance` ("the watchlist") | "Watch a cache" does not exist for players; owner find alerts undocumented. |
| Needs maintenance | Flag when the last 3 found/DNF logs are DNFs (`community.ts:245-265`). | `caching.md#community` ("the owner sees needs maintenance flags") | Threshold missing. |
| Badges | Find: `first-find` (1), `finder-10`, `finder-50`, `finder-100`, `finder-500`; `rf-verified` (any Tier A); type: `summiteer` (sota), `park-hunter` (pota), `rover-hunter` (aprs_living), `flora-fauna` (wwff), `castle-hunter`, `bunker-hunter`; hide: `hider` (1), `cache-architect` (5), `cache-master` (20) (`community.ts:345-418`; names `apps/web/src/profile/badges.ts:12-28`). Supporter is a recognition flag, not a badge (`community.ts:147`). Embeddable SVG `/badge/<call>.svg` (`badge.ts:1-40`). Only verified finds count. | not listed anywhere | Full list needed on `community.md`. No badge for traditional/multi/audio/virtual types. |
| Ranks / points | Points per distinct cache = tier base (A 10, B 5, C 2) + D + T, best find wins (`community.ts:18-20`). Leaderboard by points or finds, period all/month/year, area bbox; only verified finds by control-verified callsigns (`community.ts:21-23,40-65`). Corroborator board (`community.ts:164-185`). | `caching.md#community` (board exists) | Formula, periods and "verified callsign required" missing. |
| Adoption | Sysop offers; requester needs a control-verified call; 14-day owner notice unless owner withdrawn; sysop approves; hand-over keeps finds/logs/media (`adoption.ts:1-37,141`). | `caching.md#adopt-a-cache` | Covered; "edit it and set it active" has no UI. |
| Owner edit / disable / archive | Only via `PATCH /api/caches/:id` (`caches.ts:393-464`; route `app.ts:703`); no web caller (no `updateCache` in `apps/web/src`). | `caching.md#hide-a-cache` (API) | Players cannot maintain their caches in-app; doc must not send them to the API. |
| Heritage caches | Imported by the sysop: SOTA, POTA, WWFF, WWBOTA→`bunker`, OpenCaching/GCAU→`traditional`/`multi`, IOTA→`traditional`, OSM/Wikidata/GeoJSON→ sysop-chosen type (`workers/gateway/src/import/sources.ts:64-69,73-397`). Owner is the source name; attribution `source_name`, `source_url` (`0001_baseline.sql:245-249`); cross-source dedup, ham programs win (`import/engine.ts:10-14,56-80`). Loggable like any cache; finds on imported caches never federate (`federation.ts:748-751`). Castles: no castle-typed import adapter found (only OSM with `scope.type`). | `caching.md#heritage-places-on-the-map` | Loggability, scoring and "stays on this instance" for finds missing; "castles and lighthouses" are OSM/Wikidata with a chosen type. |
| fed_scope | `public` (default) / `unlisted` (federates title+location, **no description**) / `local-only` (never federates; switching to it emits a tombstone) (`dto.ts:27-28`; `federation.ts:82-99,727`; `caches.ts:455-461`). Unlisted caches are still on the local map, search and RSS (`caches.ts:242-247`, `feeds.ts:105`, `search.ts:51`). UI help text is correct (`HidePanel.tsx:12-16`). | `caching.md#hide-a-cache` | Docs say "Unlisted — shared, but not listed": wrong. |
| Does the hint federate? | No — redacted in `cacheData` (`federation.ts:82-97`). | `caching.md`, `HidePanel.tsx:285` | Covered. |
| Remote caches / finds | Mirrored peer caches shown when origin is `trusted`; `unvetted` hidden unless "unvetted network data" is on; `blocked` never (`caches.ts:230-266`). Remote caches read-only, log at home (`RemoteCachePanel.tsx`). Remote finds stored in `remote_finds` (`0001_baseline.sql:907-921`). | `caching.md#the-map` (filter switch), `guides/federation.md` (operator) | No player explanation of "this cache lives on another instance". Goes to `your-instance.md`. |
| Offline packs | One Maidenhead square; ≤5000 caches, ≤5 latest logs, ≤250 MB (`packages/shared/src/offlinepack.ts:14-18`); excludes archived (`offlinepack.ts:46`); owner "Pack my caches" with attention list (`offlinepack.ts:69-77,244-285`; `OfflinePanel.tsx:241-247`); hourly download limit (`offlinepack.ts:123`). | `offline.md#offline-packs` | Covered. |
| Offline map / app shell / sync | Service worker `apps/web/public/sw.js`; Background Sync for the log queue (`sw.js:186`); PMTiles offline map when the instance offers one (`apps/web/src/offline/tiles.ts:3-13`). | `offline.md` | Covered. |
| "You're near" prompt | Server-side: an ingested **APRS position** of your callsign within **150 m** of an active cache sends a prompt over the live socket (`workers/gateway/src/live.ts:17,42-85`). | `caching.md#the-youre-near-prompt` | Docs imply the phone triggers it; it needs your beacon to be heard. |
| Announce to APRS-IS | Opt-in, verified callsign only (`caches.ts:822-823`, `announce.ts`). | `caching.md#log-a-find` (one clause) | Where to opt in not stated. |
| Device signing | Ed25519 signature over cache, instance, logger, log type, time; key must be registered to the call (`caches.ts:499-517`). Comment and device reading are not signed (`logQueue.ts:9-10`). | `account.md#your-finds-are-signed` | Covered. |

### Known issues found while checking

These are behaviours that look wrong for trust, game integrity or privacy. The docs will describe the code as it
is and mark each one **Known issue**; none is fixed in the documentation work. Access-control findings were
reported to the owner privately, as `SECURITY.md` asks, and are not listed here.

- **One find per person** holds for radio logs but not for the app. The app allows one find per exact
  callsign string, so each SSID can log the same cache.
- **Finds under an SSID never reach the leaderboard**, which counts only verified base calls. Profiles and
  ratings also split by SSID, which goes against the "identity, not call strings" rule.
- **Archived and disabled caches still accept finds**, in the app and over the radio. The offline guide and the
  log queue say an archived cache refuses one.
- **Owners can log finds on their own caches**, and earn points and badges for them.
- **Players can hide SOTA and POTA "caches"**, and finds on them award the summit and park badges.
- **WWFF, bunker and castle caches cannot be filtered** on the map or in offline packs.
- **A living cache's pin never moves.** Its map position stays where it was hidden, and a phone at that spot
  reaches Tier B.
- **A living cache can follow any station.**
  - The hide form takes a free-text station callsign, with no consent from that station.
  - Rendezvous are shown publicly, with place and time.
- **A multi-stage find needs no stages.** The find is verified at the cache pin. The schema calls that pin the
  final position, while the stage code calls it the public start.
- **Replacing a cache's stage list keeps the old unlocks.** A finder who unlocked an old stage sees the new stage
  with that number.
- **Owner-only log types are not owner-only in the API.** Maintenance, enabled and disabled logs are limited to
  owners in the app only.
- **The minimum tier is fixed at B**, while the manual says each instance sets it. An owner who raises a cache's
  minimum cannot set it back to the default.
- **"Unlisted" is documented as "not listed".** In fact unlisted caches show on the local map, in search and in
  RSS, and their title and position federate.

### UX gaps (proposals, not built)

- There is no in-app way to edit, disable or archive a cache, add stages to it, or raise its minimum tier.
- The per-cache "watch" toggle has no UI and nothing reads it. The working watchlist watches callsigns.
- There is no tag or country filter in the UI, though caches carry both.
- Desktop has no install walkthrough in the manual, only its README.
- The app does not say how an instance can be reached (internet, 44Net, HAMNET, radio). "Getting to your
  instance" needs that.

## Link census

Every reference to a manual page, in all its forms, counted per target. A move updates each of them (G4).

Excludes the false positive and path-glob rows. `mkdocs nav` is the nav entry itself.

| target page | intra-docs | mkdocs nav | in-app (slug/nav/TermHelp) | published URL / GitHub blob | repo md links (outside docs/) | scripts / config / comments / generator | total |
|---|---|---|---|---|---|---|---|
| `glossary.md` | 57 | 1 | 6 |  |  | 1 | **65** |
| `operate/deployment.md` | 20 | 1 | 3 | 3 | 1 | 24 | **52** |
| `operate/rf-ingest.md` | 23 | 1 | 1 |  | 2 | 6 | **33** |
| `reference/configuration.md` | 13 | 1 | 1 |  | 2 | 11 | **28** |
| `operate/44net.md` | 14 | 1 |  | 1 | 6 | 4 | **26** |
| `operate/first-hour.md` | 13 | 1 | 2 | 1 | 1 | 7 | **25** |
| `operate/rf-regulatory.md` | 16 | 1 | 1 |  |  | 5 | **23** |
| `guides/federation.md` | 13 | 1 | 1 |  | 3 | 4 | **22** |
| `operate/administration.md` | 16 | 1 | 1 |  |  | 2 | **20** |
| `operate/helpers.md` | 11 | 1 |  |  |  | 7 | **19** |
| `operate/pocket.md` | 5 | 1 |  |  | 6 | 6 | **18** |
| `concepts.md` | 14 | 1 | 2 | 1 |  |  | **18** |
| `guides/caching.md` | 13 | 1 | 2 |  | 1 |  | **17** |
| `operate/meshcom.md` | 8 | 1 |  |  | 2 | 5 | **16** |
| `reference/cli.md` | 5 | 1 | 1 |  |  | 6 | **13** |
| `index.md` |  | 1 | 6 | 5 |  |  | **12** |
| `operate/docker.md` | 8 | 1 | 1 | 1 | 1 |  | **12** |
| `start-here.md` | 5 | 1 | 2 | 3 |  |  | **11** |
| `guides/my-radio.md` | 10 | 1 |  |  |  |  | **11** |
| `guides/account.md` | 9 | 1 |  |  |  |  | **10** |
| `reference/testing.md` | 5 | 1 | 1 | 1 | 1 |  | **9** |
| `reference/meshcom-extudp.md` | 6 | 1 |  |  | 1 | 1 | **9** |
| `reference/cloudflare-costs.md` | 5 | 1 |  |  |  | 3 | **9** |
| `design/design-language.md` | 1 | 1 | 1 |  | 1 | 4 | **8** |
| `reference/api.md` | 5 | 1 | 1 | 1 |  |  | **8** |
| `reference/federation-wire.md` | 4 | 1 | 1 | 1 | 1 |  | **8** |
| `getting-started.md` | 2 | 1 | 1 | 2 |  |  | **6** |
| `design/radio-find-logging.md` | 3 | 1 |  |  | 2 |  | **6** |
| `operate/packet.md` | 4 | 1 | 1 |  |  |  | **6** |
| `reference/licence-sources.md` | 5 | 1 |  |  |  |  | **6** |
| `about.md` | 1 | 1 | 1 | 1 | 1 |  | **5** |
| `operate/quickstarts.md` | 4 | 1 |  |  |  |  | **5** |
| `contribute/style-guide.md` |  | 1 |  |  | 1 | 2 | **4** |
| `design/meshcom.md` |  | 1 |  |  | 2 | 1 | **4** |
| `guides/shack.md` | 2 | 1 | 1 |  |  |  | **4** |
| `operate/rig-weather.md` | 2 | 1 | 1 |  |  |  | **4** |
| `operate/offline-map.md` | 1 | 1 |  |  | 1 |  | **3** |
| `design/meshcom-tdeck-map.md` |  | 1 |  |  | 1 |  | **2** |
| `reference/specs.md` |  | 1 | 1 |  |  |  | **2** |
| `reference/data-model.md` |  | 1 | 1 |  |  |  | **2** |
| `guides/offline.md` | 1 | 1 |  |  |  |  | **2** |
| `reviews/federation-validation-2026-09.md` |  |  |  |  | 1 |  | **1** |
| `reference/federation-operations.md` |  |  | 1 |  |  |  | **1** |
| `play/index.md` | 1 |  |  |  |  |  | **1** |
| `reviews/doc-inventory.md` | 1 |  |  |  |  |  | **1** |

Pages with no inbound reference at all: `reviews/design-ia-proposal-2026-10.md`, `reviews/design-review-2026-10.md`, `reviews/doc-sanity-2026-10-01.md`.

Outside-`docs/` references per file: `mkdocs.yml` 42, `deploy/lib/doctor.sh` 28, `TODO.md` 26, `apps/web/vite-docs.ts` 23, `README.md` 15, `packages/shared/src/configdocs.ts` 14, `tools/config/envfiles.mjs` 7, `deploy/pocket/README.md` 6, `deploy/.env.example` 5, `deploy/oci/README-stack.md` 4, `apps/web/src/Landing.tsx` 3, `deploy/README.md` 3, `deploy/pocket/pocket.sh` 3, `servers/node/README.md` 3, `.claude/rules/docs-and-comments.md` 2, `.env.example` 2, `.github/workflows/ci.yml` 2, `.github/workflows/docs.yml` 2, `.vale/styles/APRScaching/Terms.yml` 2, `apps/web/src/Platform.tsx` 2, `apps/web/src/demo/UiKit.tsx` 2, `apps/web/src/docs/DocsPanel.tsx` 2, `apps/web/src/identity/AdminPanel.tsx` 2, `apps/web/src/platform/TermHelp.tsx` 2, `apps/web/test/diagrams.test.ts` 2, `deploy/lib/shapes/cloudflare.sh` 2, `deploy/lib/shapes/desktop.sh` 2, `deploy/test/helpers-test.sh` 2, `tools/config/generate.mjs` 2, `workers/gateway/wrangler.toml` 2, `.claude/rules/ui-ux.md` 1, `.github/ISSUE_TEMPLATE/config.yml` 1, `.github/workflows/pocket-termux.yml` 1, `.github/workflows/release-verify.yml` 1, `.vale.ini` 1, `CONTRIBUTING.md` 1, `INDEX.md` 1, `SUPPORT.md` 1, `apps/ingest/src/index.ts` 1, `apps/web/src/caches/DetailPanel.tsx` 1, `apps/web/src/log/LogForm.tsx` 1, `apps/web/src/profile/ProfilePanel.tsx` 1, `apps/web/src/shack/ShackPanel.tsx` 1, `apps/web/src/styles/tokens.css` 1, `apps/web/src/ui/Icon.tsx` 1, `apps/web/test/visual/run.mjs` 1, `deploy/aprscaching` 1, `deploy/lib/net44.sh` 1, `deploy/lib/shapes/selfhost.sh` 1, `deploy/pocket/extras/usb-kiss.sh` 1, `deploy/pocket/extras/usb_kiss_bridge.py` 1, `deploy/pocket/meshcom-setup.sh` 1, `deploy/pocket/update.sh` 1, `deploy/setup.sh` 1, `packages/aprs/src/meshcom/normalize.ts` 1, `packages/aprs/src/meshcom/parse.ts` 1, `packages/shared/src/config.ts` 1, `servers/node/src/server.ts` 1, `workers/gateway/src/env.ts` 1.

### What the census changes in the plan

- **Stale today (independent of the move):** `apps/web/vite-docs.ts:36` lists `reference/federation-operations`,
  which does not exist. The `.env.example` ×2, `tools/config/envfiles.mjs` ×4 and `workers/gateway/wrangler.toml`
  ×2 comments say `docs/operate/deployment.md "Cost on D1"` / `"Write budget"`; both sections are in
  `reference/cloudflare-costs.md`. The `.env.example` files are generated, so fix `envfiles.mjs`, then regenerate.
- **Missing target (planned page):** `docs/contribute/style-guide.md:60` → `../play/index.md`.
- **Generated links:** 13 links in `packages/shared/src/configdocs.ts` render into `reference/configuration.md`.
  Edit them in the TypeScript file, never in the page.
- **Functional path dependencies:** `tools/config/generate.mjs:72` (configuration.md), `deploy/test/helpers-test.sh:439`
  (cli.md), `.github/workflows/ci.yml:48` path filter (cli.md), and `deploy/lib/doctor.sh:24`
  `DOCS_URL="docs/operate"`. Every doctor hint is `$DOCS_URL/<page>.md`, so moving `operate/` → `run/`
  is a one-line change there. `deploy/lib/net44.sh:35` `N44_DOCS` is a separate hardcode.
- **Shell and Python messages shown to operators:** `deploy/aprscaching:90`, `deploy/setup.sh:285`,
  `deploy/lib/shapes/{cloudflare,desktop,selfhost}.sh`, and `deploy/pocket/{pocket,update,meshcom-setup}.sh` +
  `extras/usb-kiss.sh` + `extras/usb_kiss_bridge.py`. The check must scan these as well as Markdown.
- **In-app slugs:** `Landing.tsx:252/288/372` (`guides/caching`, `concepts`, `operate/deployment`),
  `AdminPanel.tsx:908/971` (`operate/deployment`, `operate/first-hour`), `UiKit.tsx:479`
  (`design/design-language`), TermHelp → `glossary` (terms `tier`, `corroboration`, `shack`), and
  `apps/web/test/visual/run.mjs:104` (`index`) and `diagrams.test.ts:44-45` (`start-here`). They are plain
  strings, so no check catches a broken one today.
- **Published URLs:** `README.md` (14 deep links into `start-here/`, `operate/…`, `reference/…`,
  `getting-started/`, `concepts/`, `about/`), `.github/ISSUE_TEMPLATE/config.yml:10`, `INDEX.md:7`,
  `SUPPORT.md:9` and `mkdocs.yml:8` (site root only). Under G4 every deep link in the README must change with the move.
- **GitHub blob URLs:** `deploy/oci/README-stack.md:107/200` link `blob/main/docs/operate/…`. This is a
  fourth URL form. It points at `main`, so it breaks only after a release, not on the PR.
- **New files from this phase** (`.vale.ini:1`, `.vale/styles/APRScaching/Terms.yml:1`, a comment in `.github/workflows/docs.yml`) name `contribute/style-guide.md`, `glossary.md` and `design/design-language.md` in comments. `Terms.yml` must follow the design-language move.
- **`CHANGELOG.md` does not reference any manual page.** `TODO.md` has 26 relative links into `docs/`. It is a
  live document, so update them.
- **Dated reviews** (`docs/reviews/*`) link to manual pages. They are history, and the not-in-nav rule exempts
  them from present tense. Under G4 a moved target still breaks `mkdocs build --strict`, so either update those
  links or exclude `reviews/` from link validation on purpose. One "link" at `design-review-2026-10.md:105` is a
  false positive: quoted Markdown inside inline code.

### The in-app manual today

`apps/web/vite.config.ts` registers `docsPlugin(path.resolve(webDir, "../../docs"))`. The plugin serves a
virtual module, `virtual:docs` (typed in `apps/web/src/vite-env.d.ts`), with one export:
`DOC_PAGES: { slug, title, section, order, body }[]`.

How it builds the list (`build()`, run on every `load`):

1. **Discovery.** `listMarkdown(docsDir)` walks the whole `docs/` tree recursively and takes every `*.md`
   file. **Nothing is excluded.** It ignores mkdocs `exclude_docs` (harmless, since `LICENSE` is not `.md`)
   and also `not_in_nav`. So the five dated reviews under `docs/reviews/*` are bundled and listed in the
   reader under "More". `docs/contribute/style-guide.md` appears the same way.
2. **Slug** = the path relative to `docs/` without `.md` (`operate/first-hour`). It is the `?view=docs&doc=`
   value and the `onDocs`/`openDocs` argument. `markdown.ts` `resolveDocHref()` resolves a page's relative
   `.md` link against the current slug's directory (`joinSlug`) and emits
   `<a href="?view=docs&doc=<slug>" data-doc data-anchor>`. **No check ever tests whether that slug exists.**
   `DocsPanel` just renders an empty state when `DOC_PAGES.find()` misses. A link out of `docs/` (for example
   `../../deploy/README.md`) becomes a bogus slug too.
3. **Title / section / order** come from a hardcoded `NAV` array of 23 entries. The comment says it "mirrors
   mkdocs.yml nav (kept in sync by hand)", and it does not.
   - title = `NAV.title` ?? the first `# ` heading ?? the slug
   - section = `NAV.section` ?? `SECTION_FOR_DIR[top dir]` (`guides`→Guides, `operate`→Operating an
     instance, `reference`→Reference) ?? `"More"`
   - order = the NAV index, or else `1000 + slug.length`. Pages outside NAV are sorted by the **length of
     their slug**, which is effectively arbitrary.
4. **Grouping** happens in `DocsPanel.useSections()`. It groups in first-appearance order with `find()`, so
   a page outside NAV joins an existing section's group at that group's end.
   Today's rendered order is:
   - Overview: index, getting-started, concepts
   - Guides: caching, shack, federation, account, offline, my-radio
   - Operating an instance: deployment, docker, first-hour, rf-ingest, packet, rig-weather,
     rf-regulatory, administration, 44net, pocket, helpers, meshcom, offline-map, quickstarts
   - Reference: api, federation-wire, configuration, cli, testing, specs, data-model, meshcom-extudp,
     licence-sources, cloudflare-costs
   - About: about
   - More: glossary, start-here, design/meshcom, reviews/doc-inventory, contribute/style-guide,
     design/design-language, design/meshcom-tdeck-map, design/radio-find-logging, and the other 4 reviews
5. **Dev HMR.** The plugin watches `docsDir` and, on any change, invalidates the virtual module and sends a
   full reload.

**Stale or divergent entries today, compared with `mkdocs.yml`:**

| vite-docs | mkdocs.yml | problem |
|---|---|---|
| `reference/federation-operations` "Federation operations" (Reference) | — | **page does not exist** |
| `getting-started` "Getting started" in Overview | "Run from source" under Develop & contribute | wrong title and section |
| `concepts` in Overview | top-level "Core concepts" | section differs |
| `guides/federation` in Guides | under Operating an instance | section differs |
| `operate/rig-weather` in Operating an instance | under Guides | section differs |
| `reference/testing` "Testing & e2e tooling" in Reference | "Testing & verification" under Develop & contribute | title and section differ |
| `reference/specs`, `reference/data-model` in Reference | under Develop & contribute | section differs |
| (absent) `start-here`, `glossary` | top-level "Start here", "Glossary" | land in **More**, near the bottom |
| (absent) `guides/account`, `guides/offline`, `guides/my-radio` | Guides | unordered tail, titles taken from H1 |
| (absent) `operate/helpers`, `pocket`, `offline-map`, `quickstarts`, `meshcom`, `44net` | Operating an instance | unordered tail, so the H1 title differs from the nav label, e.g. "Pocket: a station on an Android phone" |
| (absent) `reference/cloudflare-costs`, `meshcom-extudp`, `licence-sources` | Reference | unordered tail |
| (absent) `design/*` ×4, `contribute/style-guide` | Design notes / Develop & contribute | land in **More** |
| (included) `reviews/*` ×5 | `not_in_nav` | **should be excluded**, but they are shown in the reader |
| sections "Overview", "Guides", "Operating an instance", "Reference", "About", "More" | Overview · Start here · Guides · Core concepts · Glossary · Operating an instance · Reference · Develop & contribute · Design notes · About | the lists differ |

**Deriving the nav from `mkdocs.yml` at build time:**

- **Parse `mkdocs.yml`.** It contains a `!!python/name:` tag (the superfences mermaid formatter), so a plain
  `yaml.parse` fails. Either slice the `nav:` block, as `tools/checks/docs.mjs` already does with a regex, and
  YAML-parse only that block, or use the `yaml` package with a custom tag that ignores `!!python/*`. The
  plugin runs in Node at build time, so no runtime dependency is needed. A shared tiny parser in
  `tools/` (e.g. `tools/docs/nav.mjs`) could serve both the plugin and `docs.mjs`.
- **Walk the nav tree.** A top-level `Label: page.md` becomes a page in a section of the same name, or folds
  into a "Start" group. A `Label: [children]` becomes a section, and each child's label becomes the title.
  The order is the nav order. A nested sub-section, which Contribute → Design notes will need, needs either
  a two-level group in `DocsPanel` or a flattened "Contribute · Design notes" section label.
- **Replace** the `NAV` array and `SECTION_FOR_DIR` with that walk. A page with no nav entry gets nothing.
- **Exclusions.** Drop pages that match `not_in_nav` (reuse the glob→regex from `docs.mjs`) and
  `exclude_docs`. Either keep the reviews out of the bundle or bundle them unlisted, so that links to them
  still resolve. The bundle also shrinks.
- **Fail the build.** Make `build()` throw (Vite then fails) on:
  - a nav entry whose file is missing
  - a `.md` file in neither the nav nor `not_in_nav`
  - every relative `.md` link in a bundled page whose resolved slug is not in the set
  This duplicates `docs.mjs` check 3, so better: export the check from one module and call it from both.
- **Watch `mkdocs.yml` in `configureServer`.** The plugin watches only `docsDir` today, so after the change a
  nav edit would not hot-reload.
- **Test.** Add a vitest in `apps/web/test/` that runs the nav walk on the real `mkdocs.yml` and checks that
  every slug in the source (Landing, AdminPanel, UiKit, TermHelp default, visual `run.mjs`) is in the set.
  An alternative is to type the slugs: generate a `DocSlug` union type into `virtual:docs` so that
  `onDocs("operate/deployment")` is type-checked.

### What `tools/checks/docs.mjs` checks today

`tools/checks/docs.mjs` has no dependencies and runs over `git ls-files` in the `lint + format` CI job. Its
two link-related checks:

- **Check 3, Navigation.** It slices `mkdocs.yml` from `\nnav:` and regex-extracts every `….md` value
  (`navFiles`). It fails when one of them does not exist under `docs/`. It reads the `not_in_nav: |` block
  into gitignore-style globs (`*` → `.*`, other metacharacters escaped). It fails any tracked
  `docs/**/*.md` that is neither in the nav nor matched by those globs. It **does not** read
  `apps/web/vite-docs.ts`, so the stale `federation-operations` entry passes.
- **Check 4, Links outside the manual.** It covers only the `PROSE` set minus `docs/`: root `*.md` and
  `README.md` under `deploy|tools|servers|apps|packages|workers`, without `CHANGELOG.md`, `TODO.md` or
  `.claude/rules/docs-and-comments.md`. For each line it matches inline links `](target#anchor)`, skips
  `scheme:` URLs, and fails if `dirname(file)/target` does not exist on disk. What it **misses**:
  - `TODO.md` (26 docs links), `.claude/rules/*.md` (`ui-ux.md:8`), and other non-README `*.md` such as
    `deploy/oci/README-stack.md`. Root `*.md` such as `CONTRIBUTING.md` *is* covered
  - anchors: `#…` is stripped and never verified
  - reference-style links `[x]: path`
  - **published URLs** (`https://apachler.github.io/aprscaching/…`) and GitHub `blob/<branch>/docs/…` URLs,
    which are skipped as `scheme:` links
  - **plain path mentions** (`docs/operate/pocket.md` in prose, comments, shell messages, `.env` comments,
    `wrangler.toml`), `$DOCS_URL/<page>.md` in `doctor.sh`, and **in-app slugs** in `apps/web/src`
- Inside the manual, link validity is left to `mkdocs build --strict` in `.github/workflows/docs.yml`, with
  `validation: anchors: warn`, which `--strict` promotes to failure. That job runs only on docs path changes,
  and it does not cover the in-app reader's slug resolution.

**To fail on links to nonexistent `docs/` paths and published-manual URLs under G4, extend `docs.mjs`:**

1. Build `PAGES` = the tracked `docs/**/*.md`, relative to `docs/`.
2. Scan **every tracked text file**, not only `PROSE`. Exclude the lockfile, binaries and `node_modules`.
   `CHANGELOG.md` gets an explicit exemption, or none, since it has no doc references today. For each
   file, collect the same forms the census used:
   - Relative `.md` links, inline and reference-style, that resolve into `docs/`.
   - The regex `(?<![\w.-])(?:\.\./)*docs/((?:[\w-]+/)*[\w.-]+\.md)`. Also accept a preceding `$VAR/../`,
     to catch `helpers-test.sh`.
   - `\$DOCS_URL/([\w./-]+\.md)`, resolved against the `DOCS_URL=` value read from `deploy/lib/doctor.sh`.
   - `apachler\.github\.io/aprscaching/([\w./-]*)`, mapped as `""` → `index.md`, `a/b/` → `a/b.md` or
     `a/b/index.md`. Take the base from `site_url` in `mkdocs.yml` instead of hardcoding it.
   - `github\.com/apachler/aprscaching/(?:blob|tree)/[^/]+/docs/(\S+?\.md)`
   - In `apps/web/src`: `[?&]doc=([\w/-]+)`, `onDocs\("…"\)`, `openDocs\("…"\)`, `TermHelp … doc="…"`. Also
     the TermHelp default `glossary` and its `term="…"` ids, which can be checked against `<span id>` anchors
     in `glossary.md`.

   Fail when the target is not in `PAGES`, and optionally when the anchor is not among the target's headings
   (slugified the mkdocs way: `{#id}`, `<span id>`). The census script checks anchors this way, and all of
   them resolve today.
3. Extend check 3 to vite-docs. Better still, once the nav is derived from `mkdocs.yml`, delete the
   hand-kept list. Until then, fail on every `NAV` slug that is not in `PAGES`.
4. Decide `docs/reviews/*`. Either links from reviews are validated like any other link, which `mkdocs
   --strict` already does for them, or reviews are exempt from the published-URL check only.
5. Update the docs.mjs header comment, its success message and the "CI guards" paragraph in
   `testing.md` (`contribute/testing.md` after the move). That paragraph says the check keeps "the links
   outside the manual whole".

## Outcome, 2 October 2026

The owner approved the move map as written on 2 October 2026, so the four questions above stand as proposed. The
work landed in five pull requests:

- #186: the move by audience, the link updates, the stale-reference check and the 404 page;
- #187: the Play section;
- #188: The Shack, Run an instance, Reference and Contribute;
- #189: the screenshots;
- this record.

### How each decision was applied

| Decision | Applied as |
|---|---|
| **G1** audience first | Five sections: Play · The Shack · Run an instance · Reference · Contribute, plus Glossary and About. Files sit under the section's folder. Play, The Shack, Run an instance and Contribute each open with a journey landing page, and Home is a "Who are you?" page. Every page ends with **Next**. |
| **G2** cache types | An overview table, one page per game type in the style guide's template (Traditional, Multi-stage, Living, Audio, Virtual), and one shared page for the heritage types. |
| **G3** Vale | Vale 3.24.0 runs in the docs workflow. Errors fail; title-case headings and Play-page readability warn; long sentences are suggestions. The headings rule's exceptions are whole names, so "a", "is" and "web" in a heading no longer warn. |
| **G4** no redirects | Every reference to a moved page or heading was rewritten through one map of 486 old anchors to their new places. `tools/checks/docs.mjs` fails on any reference to a page or heading that does not exist. The forms it checks: `docs/…` paths, published URLs, in-app `doc=` slugs and `onDocs` calls, configuration-schema links, and every doctor check's troubleshooting entry. The not-found page offers the five sections. |

### Moved pages

| Old | New |
|---|---|
| `concepts.md` | `reference/trust-model.md` |
| `design/design-language.md` | `contribute/design/design-language.md` |
| `design/meshcom-tdeck-map.md` | `contribute/design/meshcom-tdeck-map.md` |
| `design/meshcom.md` | `contribute/design/meshcom.md` |
| `design/radio-find-logging.md` | `contribute/design/radio-find-logging.md` |
| `getting-started.md` | `contribute/run-from-source.md` |
| `guides/account.md` | `play/join.md` |
| `guides/caching.md` | `play/index.md` |
| `guides/federation.md` | `run/federation/index.md` |
| `guides/my-radio.md` | `shack/my-radio.md` |
| `guides/offline.md` | `play/offline.md` |
| `guides/shack.md` | `shack/index.md` |
| `operate/44net.md` | `run/networks/44net.md` |
| `operate/administration.md` | `run/day-to-day/index.md` |
| `operate/deployment.md` | `run/index.md` |
| `operate/docker.md` | `run/install/self-host-docker.md` |
| `operate/first-hour.md` | `run/first-hour.md` |
| `operate/helpers.md` | `run/day-to-day/helper-command.md` |
| `operate/meshcom.md` | `run/radios/meshcom.md` |
| `operate/offline-map.md` | `run/install/offline-map.md` |
| `operate/packet.md` | `run/radios/packet-node.md` |
| `operate/pocket.md` | `run/install/pocket.md` |
| `operate/quickstarts.md` | `run/radios/quick-starts.md` |
| `operate/rf-ingest.md` | `run/radios/rf-ingest.md` |
| `operate/rf-regulatory.md` | `shack/on-air.md` |
| `operate/rig-weather.md` | `shack/rig-weather.md` |
| `reference/specs.md` | `contribute/specs.md` |
| `reference/testing.md` | `contribute/testing.md` |
| `start-here.md` | `play/index.md` |

`index.md` stays as Home. Its sections went to Play (the game), The Shack (the Shack), *How finds are
verified* (trust) and Contribute (architecture).

Besides the manual, the references updated were in these places:

- `README.md`, `TODO.md`, `CONTRIBUTING.md` and the rules;
- the web app's links (`Landing`, `AdminPanel`, `UiKit`) and a test;
- the doctor's hints, which now all point at *Troubleshooting*;
- the deploy, Pocket and setup scripts' messages;
- workflow comments;
- the configuration schema's links (with the generated configuration page and `.env.example` files regenerated);
- package comments and the dated reviews.

### Pages written, split and merged

- **New pages:**
  - Play: Your first find, Traditional, Living, Audio, Virtual, Getting to your instance, Help and FAQ.
  - The Shack: The live map, Messages over APRS and MeshCom.
  - Run an instance: Choose a shape, Check a download, Desktop, Off-grid and LAN, Cloudflare Tunnel and CDN, 44Net name and identity, HAMNET only, Troubleshooting, and the four Pocket field pages.
  - Reference: Secrets and credentials, The trust model, How federation stays honest, Rig control library.
  - Contribute: Contribute, Architecture and runtimes, The AX.25 stack, Writing a Shack plugin.
- **Split by journey step:** caching, account, Pocket, deployment, helpers, Docker, administration, federation,
  44Net, rf-regulatory, concepts, start-here.
- **Merged, each to one owner:**
  - the ingest box (five angles);
  - backups (two tools);
  - updates;
  - one-time sign-in links (with Pocket's visitors);
  - off-grid;
  - the 44Net helper summary;
  - rig control (two pages);
  - the remote box;
  - data protection (with federation's tombstones).

### Coverage of the game

| Topic | Status |
|---|---|
| Cache types | Documented: overview plus a page per type, markers in both themes. |
| Stages and unlocks | Documented: geo (the previous stage's radius, 60 m default), audio and open (on request), NFC (sealed offline at 40 bits or more). Hiders cannot set stages in the app: code gap. |
| Living caches and rendezvous | Documented: 150 m and 5 minutes for a find; 150 m, 15 minutes and 1 hour for a rendezvous. The cache page does not name the station: code gap. |
| Finding and logging | Documented: in the app, offline (queued, needs attention) and by radio (the commands, the 7-day confirmation, 10 an hour). |
| Verification | Documented in player words, with the real numbers and a diagram; the precise rules are on *The trust model*. |
| Difficulty, terrain, hints, media, ratings | Documented. |
| Favourites, watches, badges, ranks | Documented: the full badge list and the points formula. The per-cache watch has no UI and is not described as a feature. |
| Adoption | Documented, for players and sysops. |
| Heritage places | Documented: where they come from, that they log like any cache, and that their finds stay on this instance. |
| Visibility and federation, player view | Documented: Public, Unlisted and Local only as the code has them; remote caches. |
| Offline | Documented. |
| Getting to your instance | Documented: the four ways in and what works on each. The app does not show them: code gap. |

### Known issues

The manual describes each of these as the code has it and marks it **Known issue**; none is fixed by the
documentation work.

- **Duplicate finds by SSID:** one find per exact callsign string in the app (each SSID can log the same cache), while radio allows one per person.
- **Leaderboard and SSIDs:**
  - Finds logged under an SSID never reach the leaderboard.
  - The "you're near" prompt and Tier A match the exact callsign, SSID included.
- **Archived and disabled caches** still accept finds, in the app, from the offline queue and by radio.
- **Owners** can log finds on their own caches.
- **Heritage types:**
  - Players can hide SOTA and POTA caches, and earn the summit and park badges on them.
  - WWFF, bunker and castle cannot be filtered on the map or in offline packs.
  - Radio logging refuses cache codes with a slash, such as the SOTA reference `OE/ST-123`.
- **Living caches:**
  - A living cache's pin never moves, so a phone at the pin reaches Location-verified.
  - Any station can be named as the one a living cache follows.
  - Rendezvous are public, with place and time.
- **Multi-stage caches:**
  - A multi-stage find needs no stages.
  - Replacing the stage list keeps the old unlocks.
- **Minimum tier:** it is fixed at B. An owner who raises it cannot set it back, and the app cannot raise it.
- **Unlisted caches** still show on the local map, in search and in RSS, and their title and position federate.
- **APRS-IS announcements** are opt-in, but nothing in the app or the server opts in.
- **The Packet terminal** keys the radio on connect without the verified-callsign check that every other transmit path makes.
- **The Messages surface:** it shows no outgoing messages, so its **sent** badge never appears, and messages sent from the browser carry no message number, so nobody acknowledges them.

### UX gaps (proposals, not built)

- **Cache editing:** there is no in-app way to edit, disable, archive or reactivate a cache, add stages to it, or set its minimum tier.
- **Instance details:** an "About this instance" card listing the ways in (https, 44Net, HAMNET names, the service call) and the sysop. The descriptor already carries `addresses` and `operator`.
- **Messages on a phone:** Messages has no way in on a phone, from the bottom bar or from **You → Advanced**.
- **Announce switch:** an APRS-IS announce switch for verified callsigns.
- **Exports:** GPX, KML and ADIF exports in the app.
- **Ranks:**
  - a period picker (the server has month and year);
  - badge names instead of ids on the profile opened from Ranks;
  - a way to embed your badge.
- **Living caches:**
  - Name the station a living cache follows on its page.
  - Let caches made from **My stations** opt into rendezvous.
- **Filters:** tag and country filters; WWFF, bunker and castle in the type filters.
- **Alerts:** an alert bell; today alerts live under **Settings → Notifications**.
- **Radio commands:** rejected radio commands from unverified callsigns could show in the app with their reason.
- **Bug reports:** a bug-report link in **Help & credits**.
- **Rig control:** its fallback text names a Hamlib companion that does not exist.

### Found in code and scripts, outside the manual

- **Doctor backup checks:**
  - Self-host looks for `BACKUP_DIR/db/*.db.gz`, while `deploy/backup.sh` writes `BACKUP_DIR/<timestamp>.db.gz`, so those snapshots never count.
  - With `OCI_BUCKET` set, it looks only under `archives/`.
  - On Pocket it misses where `deploy/aprscaching backup` writes.
  - Desktop has no backup check.
- **Other doctor findings:**
  - `source.fork` fires when `SOURCE_REPO` is empty, not when it is the upstream.
  - The `gateway.migrations` fix says "restart" where Self-host needs a rebuild.
- **Cloudflare split:** `deploy/cloudflare/deploy-cf.sh` does not create the `aprscaching-assets` R2 bucket that the `TILES` binding names, so a first deploy may fail.
- **Desktop README:** `deploy/desktop/README.md` backs up with `deploy/backup.sh`; the manual uses `deploy/aprscaching backup`.
- **Configuration descriptions:**
  - `DIGI_VISCOUS_MS` reaches only the connected-mode digipeater, while its configuration description reads as general.
  - The configuration reference's description of `OPERATOR_LINKS_FOR_ANY_CALL` and the Remote control row read like a tutorial.

### Journey test

Each landing page's journey was walked link by link along **Next**, and the pages where Next did not lead to
the journey's next step were fixed. Install pages are alternatives and all lead to *Your first hour*. Every
page of the built site was loaded at phone width (390 px) and at desktop width (1280 px): no page scrolls
sideways and no image is missing. The screenshots were regenerated from the current UI with
`tools/teaser/run-docs.sh` and checked against their pages.

### Style baseline

On 93 manual pages, outside the dated reviews:

- 0 errors and 0 warnings;
- 228 suggestions, all sentences over 30 words;
- all 19 Play pages within the readability target (Flesch-Kincaid grade 9 or below).

### Not tested

- The journeys were walked on the built site, never by a person on a real phone: no screen reader, no
  outdoor reading.
- The install pages' commands were checked against the scripts, not run on a fresh machine of each shape.
- The ARDC and 44Net Connect statements keep their sources and **Unverified** marks; no 44Net account was used.
