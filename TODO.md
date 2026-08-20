# Launch list & deferred work

What actually **shipped** is in [`CHANGELOG.md`](CHANGELOG.md) and the product manual under
[`docs/`](docs/). This file holds two lists: the short **launch list** of what remains before the
1.0.0 tag, and below it the honest list of what is *intentionally* left for after it — and **why**
each piece waits. It's a live checklist: boxes get ticked as items land, and nothing here is a known
defect (the pre-launch hardening pass closed those).

Each item carries a rough **priority · size** where useful — `P1`–`P3` (higher = sooner) and
`S`/`M`/`L` (effort). Deferred work is grouped by *why* it waits, not by area.

## Before 1.0.0 — the launch list (target: end of September 2026)

Everything below this section is deliberately post-1.0. These five are in the tag because launch
timing is what makes them worth doing: copy and onboarding land while first impressions are being
formed, courtesy contacts go out before the audience finds us, and a release artifact needs a
release. Listed in start order — the first two have outside dependencies and lead times.

- [ ] **OpenCaching import compliance** *(S plus an external legal answer — start first)* — enabling
  OC import on a public instance carries conditions: the OKAPI-appended attribution stays intact, OC
  content renders verbatim with clickable links, and OC-derived data is never re-exported through
  federation. opencaching.de content is CC BY-NC-ND 3.0 DE, so the NC clause against a
  donation-accepting instance needs a lawyer's answer — the only launch item gated on someone
  outside the project. Import stays off unless `OKAPI_BASE` + `OKAPI_KEY` are set
  (`workers/gateway/src/env.ts`), so if the answer does not arrive in time the tag ships with them
  unset and import follows later. That fallback is what keeps this off the critical path for the
  date.
- [ ] **Trademark courtesy contacts** *(S)* — a courtesy heads-up to POTA
  (help@parksontheair.com) and to the SOTA Reflector third-party-software category about the spots
  integration, sent before the public launch rather than after it. The non-affiliation lines they
  concern are already live on the landing and about pages.
- [ ] **Privacy-first APRS-map positioning** *(S)* — landing + docs copy stating the invariants that
  already ship as the differentiator vs incumbent APRS maps: TTL'd positions, no ads or tracking,
  the source link, self-hostable. Copy only — every claim in it is already built and true.
- [ ] **Coach-mark tour content** *(S)* — real steps for the tour framework: map → cache detail →
  log a find, element-anchored. `apps/web/src/ui/Tour.tsx` is built (focus-trapped, reduced-motion,
  config-driven) and renders nothing for empty steps, so this is content, not framework. Launch week
  is the largest first-time audience the app will ever have at once.
- [ ] **Hosted OCI one-click stack** *(S)* — publish the `deploy/oci/` Resource-Manager stack as a
  zip release artifact so the "Deploy to Oracle Cloud" button resolves a hosted URL instead of
  asking for a manual upload. It hangs off the release-please release, so it lands with the tag
  rather than before it.

## Needs hardware or a live partner (can't be validated headlessly)

These are blocked on physical radio, a real peer, or a network no CI runner has — not on code.

- [ ] **Owned-RF Tier A · 44net PoP · IPIP-mesh/BGP** — genuine Tier-A corroboration needs a receiver
  *you* operate and attest for. The provenance seam is built and Tier A is designed-for; standing up the
  RF site, the 44net gateway/subnet, and mesh routing is hardware + network-ops, not code.
  See [`docs/guides/federation.md`](docs/guides/federation.md) · [`docs/operate/rf-ingest.md`](docs/operate/rf-ingest.md).
- [x] **FBB LZHUF (B0/B1) compressed forwarding + MD5 link auth** — the codec is built and **byte-exact
  against a real F6FBB oracle** (`packages/packet/src/lzhuf.ts`: N=2048 window, F=60, classic 6+6 position
  tables, B0 `[LE32 size]` framing, B1 `[LE16 CRC][LE32 size]` framing over the TransIt CRC-16). The
  **binary-block session transport** is built (`fbb-binary.ts`: SOH/STX/EOT blocks + additive checksum,
  `FA` proposals, `FS !offset` resume) and wired into the FBB session — compression is offered via
  `BBS_FORWARD_COMPRESS` and engages only when the partner's SID also advertises `B` (else it negotiates
  back to ASCII). FBB MD5 link auth (`fbb-auth.ts`) is built and tested. Byte-level round-trips,
  negotiation, and resume are unit-tested; the live compressed peer is the byte-capable F6FBB container
  (`fbbcomp`) — the only remaining step is validating an end-to-end compressed session against it at
  deploy. Wire facts pinned in [`tools/interop/LZHUF-SPEC.md`](tools/interop/LZHUF-SPEC.md).
- [ ] **Live-radio behaviour** — the pure codecs (KISS/AX.25, Meshtastic protobuf, CW/PSK31, CAT/`rigctld`,
  AXUDP/AXIP) are unit-tested; lighting them up on real hardware (a TNC, a rig, a raw-IP socket, off-air
  weak signals) is a field/deploy step by nature. See [`docs/operate/rf-ingest.md`](docs/operate/rf-ingest.md).

## Transport conformance (every connection path proven against a real partner)

The standing bar: each transport driver the box or browser can be configured to use gets one CI leg
where the counterpart is the reference implementation hams actually run — a unit-tested codec is
necessary but not sufficient (the AXUDP CRC trailer, `BROADCAST NODES`, and the FBB registration
gate were all found only against real partners). The protocol × partner matrix in
[`tools/interop/README.md`](tools/interop/README.md) is the source of truth; every leg landing
updates it. Paths CI physically cannot host (Web Serial/BLE KISS, soundcard AFSK on air, real
radios) stay documented validate-at-deploy entries — visible, never silently absent.

**Nightly additions (`interop.yml`):**

- [ ] **KISS TCP vs the kernel Linux AX.25 stack** *(P1 · M)* — `kissnetd` pty pair bridged to TCP
  via `socat`, peer services on `ax25d` (privileged job, same host-`modprobe ax25` pattern as the
  F6FBB leg). Proves FEND/FESC escaping, port nibbles, and frame boundaries against the canonical
  implementation.
- [ ] **Full FBB mail exchange vs F6FBB** *(P1 · M)* — register the partner callsign through the
  `xfbbC` sysop console (runbook in `tools/interop/README.md`), then assert a complete telnet
  forward session: proposal, delivery, BID dedup, message visible in the FBB mailbox.

**Weekly `transports.yml` (schedule + manual dispatch; the heavy/privileged legs stay out of the
nightly budget):**

- [ ] **Direwolf leg** *(P1 · L)* — two Direwolf instances over an ALSA loopback pair
  (`snd-aloop`): a real Bell-202 AFSK modem path. Our KISS TCP client on one side and the AGWPE
  client against Direwolf's AGW port (:8000) on the same instance; the same environment chains the
  igate path (Direwolf RF side → our igate → aprsc) end-to-end.
- [ ] **WA8DED hostmode vs tfkiss** *(P2 · M)* — `tfkiss` (the TheFirmware emulator, the living
  Linux lineage of TFPCX) built from source, bridged onto the KISS leg; our hostmode driver runs
  its real TNC handshake, monitor headers, and channel polling against it.
- [ ] **AXIP raw IP proto 93 vs ax25ipd** *(P2 · M)* — `ax25ipd` in `ip` mode as the partner, our
  `AxipPort` with the optional `raw-socket` dependency, CAP_NET_RAW on both containers. Completes
  the AXIP/AXUDP encapsulation pair against the reference bridge.
- [ ] **TAK/CoT vs FreeTAKServer** *(P2 · M)* — the open TAK server feeds real CoT events at our
  listener; asserts parse → normalise → `tak`-port ingest end-to-end.
- [ ] **Meshtastic vs meshtasticd** *(P3 · L, experiment)* — the official Linux-native/simulated
  node as partner for the serial protobuf framing; accepted-risk attempt, falls back to the
  hardware validate-at-deploy entry if the simulated radio path proves unstable in CI.
- [ ] **GPLSL driver conformance under Node** *(P2 · L)* — the browser driver layer
  (hostmode/AGWPE/Multiport) is byte-stream-agnostic; run it headless in Node against the same
  Direwolf/tfkiss partners so ONE conformance suite covers the box drivers and the shack
  drivers alike.

## Station hub: the box as protocol driver + universal hardware interface (owner-decided design)

The inversion of the transport work above: today the box *consumes* protocols; this program makes
it also *serve* them, so third-party packet software uses our box as its TNC/driver (the TFPCX
role, over TCP/pty instead of a DOS TSR) — and drives every kind of shack hardware underneath.
One radio, many applications: every app sees RX, the hub arbitrates TX, and the platform ingest
taps everything that flows through. Owner decisions 2026-07: all-three southbound servers (1c),
TNC2 emulation in (2a), shared arbitration (3a), hardware tier 1 through PACTOR (4c), full rig
program incl. re-export (5c), full PTT set (6a), GPS in (7a), separate hub daemon (8b), weekly
client-conformance legs (9a), fringe hardware as tier 3 (10a).

**Architecture** — new `packages/hub` (pure protocol/driver cores, unit-testable) + a separate
hub daemon process shipped in the same box image next to the ingest process (8b): crash-isolated,
restartable, talks to ingest over the existing local seam. MIT-clean like the other packages.

**Southbound servers (what 3rd-party software connects to):**

- [ ] **AGWPE-TCP server** *(P1 · M)* — the modern lingua franca (UI-View lineage, QtTermTCP,
  APRS clients): registration, monitor frames, raw frames, connected sessions.
- [ ] **KISS-over-TCP server** *(P1 · S)* — universal fallback every packet program speaks;
  multi-client with per-client port filters.
- [ ] **WA8DED/TF hostmode server over TCP + pty** *(P1 · M)* — the literal TFPCX/TFKISS role for
  Paxon/LinKT-class software: channel polling, monitor headers, autobaud prompt on the pty.
- [ ] **TNC2 command-mode emulation (`cmd:`) on telnet + pty** *(P2 · M)* — vintage terminal
  programs get the classic prompt: C/D/MHEARD/MYCALL against our real stack (2a).
- [ ] **Channel arbitration + monitor fan-out** *(P1 · M)* — shared model (3a): every connected
  app receives RX; TX serialized through a fair per-port queue with per-app budgets; session
  ownership tracked so connected-mode links stay coherent.

**Northbound hardware drivers (tier 1, 4c):**

- [ ] **Serial KISS TNC** *(P1 · S)* — classic serial/USB KISS incl. SMACK CRC variant.
- [ ] **KISS-TCP + AGW client** *(P1 · S)* — attach Direwolf/QtSoundModem/other hubs as modems.
- [ ] **Supervised Direwolf** *(P1 · M)* — the hub launches and manages a Direwolf instance
  (config generation, ALSA/pulse device pick, restart-on-crash) for soundcard AFSK/IL2P.
- [ ] **WA8DED hostmode TNC driver** *(P2 · M)* — TNC3/SCS-class firmware TNCs in hostmode.
- [ ] **SCS PACTOR hostmode** *(P2 · L)* — PTC-II/P4dragon hostmode incl. PACTOR level
  negotiation; unlocks Winlink-grade HF forwarding through the same BBS/forward stack.

**Rig control, keying, position (5c · 6a · 7a):**

- [ ] **rigctld client** *(P1 · S)* — talk to an existing hamlib rigctld (net) for
  frequency/mode/PTT; band-tag everything the hub ingests.
- [ ] **Direct CAT serial drivers** *(P2 · M)* — Icom CI-V, Kenwood, Yaesu protocol families for
  zero-dependency setups.
- [ ] **rigctld-compatible re-export server** *(P2 · M)* — the hub serves the rigctld wire
  protocol so logging/digimode apps share the rig through us — same bridge idea as packet (5c).
- [ ] **PTT/keying paths** *(P2 · M)* — CAT PTT, serial RTS/DTR, CM108 GPIO, Raspberry Pi GPIO;
  one PTT abstraction with per-port assignment and TX-watchdog (6a).
- [ ] **GPS/position sources** *(P2 · S)* — gpsd client + raw NMEA serial feeding station
  position, beaconing, and the shack map (7a).

**Conformance (9a) + fringe (10a):**

- [ ] **Client-side conformance legs in weekly `transports.yml`** *(P1 · M)* — the mirror image
  of the interop suite: real third-party clients dial OUR servers in CI (Direwolf as AGW/KISS
  client, `call`/axcall via kissattach against our KISS-TCP, tfkiss-driven hostmode session,
  hamlib `rigctl` against the re-export). Every server above lands with its leg.
- [ ] **Tier-3 fringe hardware** *(P3 · L)* — Meshtastic serial/BLE, LoRa RNode, RX-only SDR via
  rtl_tcp: roadmap-listed, attempted opportunistically after tiers 1–2 (10a).

## Native packaging

- [ ] **Capacitor mobile shell** *(P3 · L)* — reuse the web app in a native iOS/Android wrapper for
  USB-serial / BLE-KISS and background operation. A build/sign/store pipeline, not a headless code core.
  See [`docs/operate/deployment.md`](docs/operate/deployment.md).

## Growth & community (owner-decided slate; keeps the game-first orientation and the open/recognition-only style)

Next release:

- [ ] **Award ladder & endorsements** *(next release · P1 · M)* — DXCC-style tiered awards for finds and
  hides (counts, Maidenhead grid chasing, distance records) with *endorsements* by transport
  (RF-only / HF / Meshtastic) and an all-Tier-A prestige track; downloadable certificates,
  recognition-only. The proven stickiness engine of POTA/SOTA/DXCC, transplanted onto caching.
  Scoring substrate: **two ranking scopes** — instance (local rows, the club board) and network
  (local + mirrored signed records from trusted peers, Tier-A counted at the corroboration quorum).
  Each instance computes the network board from its own mirror — no central authority; rank by
  callsign with `account_id` aggregation, honor signed account-moves, show the scope as a segmented
  "This instance / Network" toggle with home-instance badges on network entries; instance awards
  issue locally, network awards claim when the trusted-peer quorum agrees.
- [ ] **FTF culture + streak souvenirs** *(next release · P1 · S)* — a permanent first-to-find line on
  each cache's log (mono-callsign glory) plus daily/weekly find-streak souvenir badges.
- [ ] **Cache-centric watchlist triggers** *(next release · P1 · S/M)* — HamAlert-pattern triggers on
  the existing watchlist + push/email-digest plumbing: new cache within X km / in grid Y, FTF still
  open, living cache activated nearby, your hide was found.
- [ ] **Shack dashboard** *(next release · P1 · M)* — a kiosk-able full-screen shack surface: greyline
  world map, propagation (SFI/K-index), live cache + POTA/SOTA spots, award progress — Pi-friendly
  over the free read API, in the retro identity. Fills the shack-display gap HamClock's shutdown left
  open. Built on the tool widget model, so the full program — surface, widgets, feeds, kiosk — is in
  *Tool ecosystem: marketplace & dashboard widgets* below.

Backlog (P3 unless noted):

- [ ] **SWL / receive-only mode** *(P2 · M)* — an unlicensed account class that participates by
  reception (RTL-SDR / WebSDR / browser bridge in RX): reception-report logs, an own SWL ladder +
  leaderboard, never touching the licensed A/B/C find tiers. The license-conversion funnel —
  receive-only participation is an explicit invariant already, so nothing about the trust model waits
  on this. The first promotion candidate out of this list.
- [ ] **Seasonal "Support Your Caches" weekends** *(S)* — quarterly themed event weekends with a
  participation certificate for everyone and plaque-style top recognition (the POTA
  support-your-parks pattern); federation peers can honor the same calendar.
- [ ] **Activator/hunter dual scoring for living caches** *(M)* — SOTA-style points for both the
  portable station being the cache and its finders, feeding the award ladder.
- [ ] **Field Day "Cache Day" tie-in** *(S)* — an annual event aligned with ARRL Field Day with a
  GOTA-style club bonus for supervised newcomer finds.
- [ ] **Club leaderboards & cache trails** *(M)* — clubs as first-class entities: aggregate club
  scores and club-sponsored named trail series with completion certificates.
- [ ] **Weekly #CacheNet** *(S/M)* — an ANSRVR-style recurring APRS-messaging net with map-visible
  check-ins and a check-in streak badge.
- [ ] **Elmer/mentor pairing** *(M)* — opt-in mentor matching per region/topic with recognition
  badges for both sides; contact stays in-platform (thin, opt-in profiles).
- [ ] **Logbook sync (Wavelog/Cloudlog)** *(M)* — extend the ADIF export into a pull API the
  self-hosted logbook tools consume (they handle LoTW/eQSL/QRZ onward).
- [ ] **Winlink/SMS gateway UI** *(M)* — friendly compose surfaces over the open APRSLink
  (Winlink↔APRS email) and APRS-SMS gateways from the messages surface.
- [ ] **Meshtastic cache mode** *(M/L)* — caches discoverable and loggable over Meshtastic with a
  distinct mesh provenance chip (always Tier C — ISM transport is never attested ham RF) and an
  optional mesh leaderboard.
- [ ] **Post-ticket onboarding quest** *(S/M)* — a guided achievement track for freshly-licensed
  hams: hear a packet → decode a frame → first gated beacon → first Tier-C/B/A find; pairs with the
  coach-mark tour.
- [ ] **Youth/event cache kits** *(M)* — a packaged off-grid event-instance recipe (desktop single
  binary + printable/NFC cache kit + temporary scoreboard) for camps, school demos, and hamfests.

## Tool ecosystem: marketplace & dashboard widgets

The signed **Tools** plugin platform already carries what both programs build on: per-author Ed25519
manifest signatures, an authority-signed registry with a client-pinned key and a
`verified / known / self-signed / unsigned / invalid / key-changed` trust ladder, declarative panels
and map layers a sandboxed tool contributes without touching the DOM, and capability grants gated at
the host. Two programs extend it — a **dashboard surface** so a tool can contribute a widget, and a
**public tool bucket** so anyone can publish one. Breadth belongs in the bucket, not the core: the
first-party widget set stays small and excellent, and the long tail (satellites, cluster feeds,
aircraft layers) is what the marketplace is *for*.

The dashboard is the app release and it is scoped to one thing: a ham puts it on a screen in their
shack, with no account and no first-party server. The bucket is a separate repo on its own timeline —
only its in-package prerequisites touch a shipped build. Ordering that matters: the `ToolSurface`
rename lands before any new surface work and before the package becomes a contract third parties
compile against; `entryHash` lands before anyone lists, because it changes what a signature covers;
the dashboard surface lands before built-ins can declare it.

A bucket repo rather than a code monorepo or a publish service, because the binding constraints are
liability, bus factor, and running cost: entries are metadata pointing at author-hosted artifacts, so
listing never makes the maintainer the host of third-party code; the signed registry is a static file
any CDN serves, with no always-on authenticated infrastructure to die with its operator; and the
whole thing is forkable, so a community can clone and re-key it. It maps 1:1 onto the `RegistryEntry`
format that already exists.

Next release:

- [ ] **`ToolSurface` rename (prerequisite)** *(next release · P1 · S)* — the tools package exports
  `Surface` (a tool's host surface) while `packages/shared/src/surfaces.ts` exports an unrelated
  `Surface` (the app's page sitemap), and `apps/web/src/shack/apps.ts` sits between the two. Rename
  the tools-package type to `ToolSurface` before the package becomes a public contract. Six files,
  mechanical, tests green.
- [ ] **Dashboard surface, widget nodes + kiosk workspace** *(next release · P1 · M)* — add
  `dashboard` to the tool surfaces; a widget is a `PanelSpec` rendered on that surface, so the
  sanitizer, the sandbox, and the blind-router host apply unchanged. Three new panel node kinds
  (`clock`, `gauge`, `sparkline`) plus an optional `size` hint the host may ignore — the host owns
  layout, tools only hint; no images, iframes, or raw HTML. A shack workspace app arranges installed
  widgets in a grid, persisted like the nav pins. Kiosk mode (`?kiosk=1`, 800×480 up) is public and
  signed-out with a first-party default layout, so a shack Pi shows something with no account;
  personalised layouts need one. The source link stays in the kiosk footer.
- [ ] **First-party widget set v1 (feed-free)** *(next release · P1 · S each, four of them)* — the
  widgets that need no backend at all: UTC/local clocks with sun and moon rise-set, the greyline
  terminator (deterministic solar math, host-side, and the emotional anchor of the whole surface),
  live cache spots, award progress. Two existing built-ins join for the cost of a manifest line by
  declaring the new surface rather than being rewritten: `mheard` (recently-heard sparkline) and
  `watch-alert` (watchlist). The caching widgets are the differentiator — clocks and greyline are
  table stakes. Four times S is the real cost here; adding a fifth widget is a release decision, not
  a free one.
- [ ] **Pi / thin-client kiosk one-liner** *(next release · P1 · S)* — an install script that puts a
  box into boot-to-dashboard kiosk, plus a recipes doc covering repurposed HamClock hardware, Android
  TV, Fire TV (browser, or a kiosk launcher for boot-to-app), and old tablets. One install command is
  the pattern those users already know, and it is how the migration actually happens.
- [ ] **HamClock-migration guide + positioning page** *(next release · P2 · S)* — the displaced-user
  window is open now: the original backend sunset in June 2026 and migration write-ups are still
  circulating. "Run it on the Pi your HamClock used — or on the TV you already own, free." Honest
  about OpenHamClock being complementary with a different centre of gravity. Ships with the dashboard
  or it misses the window.

Marketplace track (a separate repo on its own timeline; only the first two items touch a shipped
build, and neither gates the release):

- [ ] **`entryHash` content pinning (prerequisite)** *(P1 · S)* — a manifest signature covers the
  manifest fields including the `entry` URL, but not the script bytes that URL serves, so whoever
  controls the hosting can swap the payload while the signature still verifies. Add `entryHash`
  (SHA-256 of the script) to `ToolManifest` *inside* the signed bytes; the sandbox hashes what it
  fetched and refuses to evaluate on mismatch; `tools/toolkey` computes it on sign; bucket CI fetches
  and verifies it independently. A new signed field changes `manifestSigningBytes`, so the shipped
  `hello` tool and `apps/web/public/tools/registry.json` are re-signed in the same change. Must land
  before anyone lists — a required signed field cannot be retrofitted afterwards. Side effect worth
  having: a script change now forces a version bump and a re-signed manifest.
- [ ] **Multi-pin registry authority** *(P1 · S)* — `verifyRegistry` accepts a small allowlist of
  authority keys instead of a single pinned one, so a rotation ships the new key alongside the old and
  older builds keep verifying through the overlap window. Keep the list at three or fewer and cover
  the forged-authority rejection path — the whole registry trust model rests on this function.
- [ ] **Tool bucket repo + signed publish** *(P1 · M)* — a public `aprscaching-tools` repo, one JSON
  file per tool under `bucket/`, so a pull request is single-purpose and pubkey continuity is a
  one-file diff. Validation reuses `@aprscaching/tools` (MIT and dependency-free precisely so it can):
  schema, live manifest fetch, a `valid` signature required for listing, independent `entryHash`
  verification, HTTPS-only immutable `entry`, no pubkey change for an existing name outside a
  maintainer-approved rotation, and an automatic review label for the gated capabilities (`network`,
  `tx`, `beacon`, `geo`). Listed tools ship a readable, non-minified entry script so review audits the
  exact bytes the hash then freezes — human review is the enforcement, CI only flags obvious
  minification. Merge builds and signs `registry.json` from the bucket and deploys it to Pages from a
  reviewer-protected environment; an offline root key designates the online CI signing key, and its
  custody and rotation ship documented with the repo. Listings state a license. Decide the custom
  domain before shipping: `VITE_TOOL_REGISTRY` points at that URL permanently.
- [ ] **Built-in extraction to the bucket** *(P2 · S/M)* — dogfood the marketplace and produce the
  authoring walkthrough by moving the self-contained built-ins out as first-party signed listings: the
  SSID reference, CTEXT macros, auto-responder, 7plus, the beacon scheduler (which also exercises a
  gated capability end to end), then unit convert, CW encode, grid/bearing, block art, and map
  waypoints. Staying in-process, deliberately: the monitor colouriser and the PSK31/CW decoders (the
  sandbox decode bridge is an async request/response, the wrong shape for a continuous audio loop, and
  a field station must decode on first run with no network to fetch an import); the station database
  and link ping, which feed the inter-tool bus other tools read; and the peer-facing session tools —
  auto-status, scheduled query, info responder, away note, connect bell. Needs the `dashboard` surface
  and the bucket both live, so it is the last domino, never a release blocker.

Backlog (P3 unless noted) — the first three are what a second dashboard release picks up:

- [ ] **Feed proxy v1 + feed-backed widgets** *(P2 · M)* — widgets must not each hit upstreams from
  every browser. A scheduled server-side fetch and cache exposes versioned `/api/feeds/*` under the
  free read API (Workers cron, Node/Bun interval, D1/SQLite cache table), and a first-party feed tool
  re-exposes it over the host IPC bus, so a third-party widget needs no `network` grant for curated
  data — which is what keeps that grant meaningful. Every response carries source and fetched-at so a
  widget labels stale data by age; every feed gets a circuit breaker and stale-while-revalidate,
  because the POTA API is unofficial and can break without notice — a widget shows old data with its
  age, never a blank panel. First feeds: NOAA space weather (US public domain, no key), POTA/SOTA
  spots, contest calendar, on polite TTLs. Unlocks the solar gauges and the spot widgets. Held out of
  the first dashboard release on purpose: it is the only tri-runtime piece in the program and the only
  one with a standing upstream-maintenance cost, and the dashboard is worth running with no
  first-party server at all — that property is the answer to how HamClock died, so it ships proven
  first.
- [ ] **PWA offline app shell** *(P2 · S)* — the web manifest ships and installs today; the service
  worker is push-only by design (`apps/web/public/sw.js`). Add an app-shell precache and an offline
  fallback without disturbing the push registration path in `apps/web/src/push.ts`. The field station
  is the point: the app opens with no network.
- [ ] **10-foot TV mode** *(P2 · S)* — a kiosk variant for a TV across the room: large type,
  overscan-safe margins, no pointer or hover dependency, and a burn-in guard (slow pixel shift plus a
  dim schedule). One mode covers Fire TV, Android TV, and the Samsung/LG browsers. A free web route is
  the deliberate answer to the paid TV app the community backend sells.
- [ ] **Kiosk pairing code** *(P2 · M)* — a headless display opens `/tv` and shows a six-character
  code; an operator claims it from a signed-in device and the display loads their layout. Account
  prefs are the transport, no new protocol. Kills D-pad URL typing, the single biggest smart-TV
  usability barrier — pairs with TV mode, not before it.
- [ ] **Tool update flow** *(P2 · S)* — the Tools console diffs the installed version against the
  registry entry and offers a one-click re-import; a scheduled bucket workflow opens an auto-pull-
  request when an author's hosted manifest is ahead of their entry.
- [ ] **Community buckets (multi-registry)** *(M)* — user-added registry URLs, each with its own
  pinned or trust-on-first-use authority key, bucket name shown in the trust label. First-party
  entries stay `verified`. Keeps the main bucket's review bar high without gatekeeping the ecosystem.
- [ ] **Satellite passes widget** *(M)* — TLE-based; a marketplace candidate first. If it lands
  first-party, the TLE feed is signed and provenance-labelled: a cache-poisoning incident in a
  comparable project is exactly why data gets signed, not only code.
- [ ] **Band conditions v2 (VOACAP-class)** *(L)* — real propagation prediction; v1 is a simple
  index-derived band table off the solar feed.
- [ ] **RSS/news widget** *(S)* — server-side title extraction on a curated ham-news list, plain
  titles to the client.
- [ ] **Box telemetry widget** *(M)* — ingest-box temperature, voltage, and GPIO over the existing
  remote relay, onto the dashboard.
- [ ] **Big Clock mode** *(S)* — a single-widget-maximised kiosk state.
- [ ] **Feed API as a published contract** *(S, doc)* — a versioned public spec so other shack
  displays can consume our feeds. An open contract is the opposite of the closed-backend failure that
  killed HamClock.
- [ ] **Native TV apps (Fire TV / Android TV)** *(M, demand-conditional)* — a thin WebView wrapper on
  the Amazon and Google stores, only if the web kiosk demonstrably falls short for TV users. Never
  paid — the recognition-only invariant holds here too.
- [ ] **Legacy HamClock backend compatibility** *(L, parked)* — speaking the community
  client↔backend protocol so an orphaned HamClock can point `-b` at an instance. Parked: revisit only
  if the community backends falter and the feed proxy already covers most of the data products.

## Future ideas (not yet built, still wanted)

- [ ] **Retro read-only access** *(P3 · M)* — small Node daemons (raw TCP/TLS, not Workers) exposing
  caches-near / station info / leaderboard over **Finger**, **Gopher**, and **Gemini**. Fits the
  "it's a network" ham-retro aesthetic.
- [ ] **Ham-radio QSO logbook** *(P3 · M)* — a worked-stations log (band/mode/freq/RST/grid) with **ADIF**
  import/export and optional LoTW/eQSL/QRZ sync, distinct from the cache logbook.
- [x] **CoT streaming feed** — `GET /api/cot/stream` is a Server-Sent Events TAK feed alongside the
  `/api/cot` bbox snapshot: it emits the snapshot then pushes station updates, so ATAK/WinTAK get live
  pushes. The runtime shells stream `text/event-stream` bodies (the Node shell pipes rather than buffers).
- [ ] **Live-room region sharding** *(P3 · M)* — shard the live WebSocket room by geohash so fan-out scales
  past a single global room.
- [ ] **One-click POI overlay** *(P3 · S)* — a map-side toggle that live-queries a curated OSM/Wikidata set
  (peaks, castles, lighthouses) for the current viewport as a switchable layer, respecting each source's
  attribution.
- [ ] **Native Meshtastic transports at the ingest box** *(P3 · L)* — native MQTT, BLE, and serial with
  protobuf decode, alongside the newline-JSON TCP bridge the box speaks today (the browser path already
  does Meshtastic over Web Serial).
- [ ] **Bring-your-own-ingest** *(P2 · M)* — a user binds their local ingest box to a cloud instance
  they don't operate: a per-user ingest grant keyed on their registered Ed25519 device key (the
  signed-batch path already authenticates one operator, own-traffic-only), extended with per-user
  site attestation so a member's IGate can relay third-party RF — sysop-approved, or automated for
  hams with a 44net-verified hostname via the existing DoH/DNSSEC binding check. Tier-A stays gated
  on attestation, never on transport.
- [ ] **Instance-served offline tile packs** *(P3 · M)* — serve basemap tile packs from the instance
  (R2 on Cloudflare, filesystem self-host) behind the reserved `TILES` binding, so off-grid deployments
  get full-detail maps without any third-party tile provider. Natural shape: a Protomaps PMTiles
  extract + a self-hosted MapLibre style wired in via `VITE_BASEMAP_STYLE` — which also removes the
  hosted default's dependency on the volunteer-run OpenFreeMap service.

## Legal & attribution follow-ups (from the licensing audit)

- [x] **Satellite-layer license** — the shipped satellite layer is EOX `s2cloudless` **2016**, the
  plain CC-BY 4.0 year, with EOX's year-matched attribution wording; newer (CC BY-NC-SA) years or a
  licensed provider are an instance override via `VITE_SAT_TILES` + `VITE_SAT_ATTRIBUTION`.
- [x] **Production vector basemap** — the default vector style is OpenFreeMap `liberty` (keyless,
  no usage caps, OSM attribution from the style); `VITE_BASEMAP_STYLE` points an instance at any
  MapLibre style URL and `VITE_BASEMAP=offline` keeps the self-contained graticule.
- [x] **Bundle font licenses + user-visible credits** — the OFL-1.1 texts ship under
  `/fonts/` alongside Fredoka/IBM Plex Mono; the CP437 webfont credit (The Ultimate Oldschool PC
  Font Pack, VileR, CC BY-SA 4.0) and the OpenTopoMap/EOX attributions render in
  Settings → About & credits.
- [x] **Third-party notices surface** — `/third-party-notices.txt` reproduces the MIT/BSD
  copyright notices and license texts for react, react-dom, maplibre-gl, uplot, zod, and
  `@mapbox/jsonlint-lines-primitives` (an MIT-fork with a missing license field — the upstream
  jsonlint notice applies), linked from About & credits; minified bundles strip headers, the
  notices file is the durable surface.
- [ ] **APRS mark re-check** *(S)* — re-check USPTO reg. 2058846 (APRS) after the 2027 renewal
  window. The landing/about non-affiliation lines covering it are live (Groundspeak/Geocaching HQ,
  APRS Foundation, Meshtastic LLC, POTA/SOTA, TAK Product Center).
- [ ] **Vendor the third-party test partners (interop peer registry)** *(M)* — every partner the
  conformance suite runs is bundled where its licence allows, so the suite is reproducible and
  offline-capable instead of depending on upstream mirrors at build time. **Vehicle:** prebuilt
  peer container images on GHCR (`ghcr.io/apachler/aprscaching-interop-*`), produced by a manual
  refresh-peers workflow; each image embeds the source tarball and licence text (GPL source-offer
  satisfied in-image), CI pulls by digest. **Version policy:** hard-pinned versions + sha256;
  bumps are deliberate and re-run the full conformance suite. Licence audit (the gate):
  - **Freely bundleable** — F6FBB/LinFBB (GPL-2, Debian `fbb`), ax25ipd/kissattach (GPL,
    `ax25-apps`/`-tools`), aprsc (BSD), and the planned Direwolf (GPL-2), tfkiss (GPL),
    meshtasticd (GPL-3): vendor with licence texts retained and GPL sources kept alongside.
  - **Conditions** — TheNetNode 1.79 "(c) NORD><LINK e.V., free for non-commercial usage": an
    isolated, clearly-labelled test fixture, notice retained, excluded from the repo's AGPL/MIT
    units, never linked into our code (CI builds from the public full-source mirror
    github.com/DeltaLima/TheNetNode-CB; dg9obu.nordlink.org hosts the ham line as the override).
  - **Courtesy note first** — JNOS 2.0 (KA9Q-lineage copyrights, no written blanket grant; public
    mirror github.com/DigitalHERMES/jnos2 already wired): note to VE4KLM, vendor on or absent
    objection.
  - **Permission required** — LinBPQ is proprietary freeware for amateur use with no
    redistribution grant: email John Wiseman G8BPQ for the binary-mirror OK; until then the image
    keeps download-at-build with the `LINBPQ_SHA256` pin.
  - **Verify at leg time** — FreeTAKServer's licence, before its CoT leg lands.
  - **Package-registry tier** — a peer installable from an apt repository changes the calculus:
    `apt-get install` at CI image-build time makes the REPOSITORY the distributor, so no
    redistribution by us happens at all (LinBPQ via the community Hibbian repo,
    apt.hibbian.org/guide.hibbian.org, therefore needs no permission on the build-per-run path —
    the G8BPQ ask applies only to publishing prebuilt public images that contain it; a private
    GHCR image avoids that too). Preference order per peer: official Debian/Ubuntu archive
    (`fbb`, `ax25-tools`/`ax25-apps`, `direwolf`; check `tfkiss`) → project-run apt repos
    (LinBPQ via Hibbian — native builds, which also retire the i386 multiarch shim in the
    Dockerfile; aprsc via aprsc-dist.he.fi; meshtasticd via the official Meshtastic repo) →
    source-bake only where nothing is packaged (TNN from the GitHub mirror with `-fcommon`,
    JNOS, FreeTAKServer via pip). The linbpq image already prefers the Hibbian repo with the
    download-at-build as fallback, and the TNN/JNOS source fetches pin immutable commit
    archives (the commit hash is the version pin; the `*_SHA256` args stay operator
    overrides) — the remaining work is the GHCR image registry itself.

## Engineering-quality follow-ups (opportunistic, not defects)

- [x] **Platform overlay state** — the map platform's "single-overlay" invariant (at most one top-level
  surface open) is modelled as one `useOverlays()` value instead of a boolean-per-panel plus a
  hand-maintained close-everything list, so opening one surface cannot leave another stuck open.

- [x] **Type-aware ESLint** — a separate, slower `lint:types` job now runs `@typescript-eslint`
  type-checked rules over `workers/` + `packages/` (the trust-critical surface), gating the real
  promise/assertion bug-catchers while the by-design `any` boundaries stay off. See `eslint.config.types.mjs`.
- [x] **Burn down the lint warnings** — the fast `pnpm lint` is at **0 warnings**; keep it there (clear
  opportunistically when touching neighbouring code, never let the count grow).
- [ ] **Tighten the type-aware warnings** *(P3 · M)* — promote `lint:types` warnings to errors rule-by-rule
  as the code is cleaned. **Done so far:** `require-await`, `unbound-method`, `no-base-to-string`, and
  `restrict-template-expressions` are now **errors** (the legitimate exceptions — the Durable Object
  hibernation handlers must be async; a data property named `apply` — carry a documented inline disable).
  Untrusted request-body fields are coerced through `asStr()` (gateway `app.ts`) / a local equivalent
  (`packages/tools`) at every boundary, so a malformed body can never stringify to `[object Object]`.
  **Left:** `no-unnecessary-type-assertion` stays a **warning** — it false-positives on generic
  `.json()`/`unknown` returns under `projectService` (auto-fixing it would strip load-bearing casts).

## Federation over RF (the wire contracts are in; the bindings land in this order)

The CBOR signed wire format, typed peer endpoints, the two-tier transport seam (sync +
store-and-forward), and ARDC-verified 44net onboarding are built — see
[`docs/reference/federation-wire.md`](docs/reference/federation-wire.md). What rides on them next:

- [x] **Serve/consume CBOR frames on the sync surface** — `GET /federation/sync/<type>` serves signed
  fedwire frames; consumers pull it exclusively (the JSON feeds are an unsigned transparency/browse
  surface), and the 2-instance conformance suite asserts the CBOR path.
- [x] **Advertise our own endpoint set** — the `/.well-known/aprscaching` descriptor publishes the
  instance's typed endpoints (`FED_ENDPOINTS` → `addresses`).
- [x] **Endpoint sets in the signed registry** — a registry entry carries the instance's typed
  endpoints (`addresses`), re-validated on load so a malformed address never rides in; the self-entry
  publishes them from `FED_ENDPOINTS`, and the signing tooling documents the field. The registry is a
  tamper-proof directory of who-is-reachable-where (addressing only, never a trust uplift).
- [x] **Retire the JSON per-record signatures** — the CBOR fedwire frame is the only signed record
  encoding: sync consumes `/federation/sync/<type>` exclusively, `/federation/submit` accepts only
  `application/cbor` (415 otherwise), relay feed answers always carry a CBOR page, and the JSON feeds
  serve unsigned browse items. The stableStringify signing base survives only for standalone signed
  documents (registry, key rotation, account operations, find-log device signatures).
- [x] **44net onboarding wizard in the admin surface** — the sysop federation panel adds a peer by
  callsign (DNSSEC-validated bindings admit in one click; otherwise the resolved key is shown for an
  explicit trust-on-first-use pin) and emits this instance's own `_aprscaching.<call>.ampr.org` TXT to
  paste into the ARDC portal.
- [x] **Connected-mode sync binding** — the `ACSL1` line protocol (HELLO caps negotiation → one CBOR
  sync page per request, `deflateDict1`-compressed when negotiated) rides the existing session
  machinery; `FedSyncApp` mounts as a node service sourcing pages from the local gateway, the pull
  side delivers pages to `POST /federation/frames` into the shared trust-gated pipeline, and the
  session driver gained ordered async command handling to support I/O-backed apps. Dialing the RF
  circuit is validate-at-deploy, like FBB forwarding.
- [x] **Store-and-forward carrier over FBB forwarding** — complete, including the relay's packet
  leg. `encodeFedBbsBatch`/`decodeFedBbsBatch` pack signed frames into a text-safe `ACSFED` bulletin
  with a content-addressed BID for mesh dedup (`packages/shared`); `POST /federation/bbs/enqueue`
  signs local feed records (tombstones first, same producer as the HTTP sync surface) into one such
  bulletin that the existing forwarding rules/pool/scheduler carry like any other; the
  forward-inbound hook routes an arriving `ACSFED` bulletin through `applyFedBbsBulletin`, which
  verifies each frame against its claimed origin's keys (last-pinned peer key + signed-registry
  binding), applies idempotently by gid, and quarantines unknown or blocked origins — receiving a
  frame lifts no trust and introduces no peer. The rendezvous relay rides the same carrier: `POST
  /federation/relay/<instance>/dispatch` packs a packet-only spoke's queued queries into signed
  `relayQuery` frames, the spoke answers off its receive path with signed `relayAnswer` frames, and
  the hub lands them scoped to the answering instance's own queue — signatures bind both directions,
  so no relay secret ever rides the air.
- [x] **Beacon tier** — one signed frame in one UI datagram (`ACSB1`). `GET /federation/beacon`
  serves the instance's signed presence record (identity + typed endpoints, trimmed to the
  single-frame fit) for the ingest box to transmit; `POST /federation/beacon` feeds a heard datagram
  into the shared trust-gated pipeline — a known origin's peer-announce refreshes its endpoints
  (update-only; a beacon never introduces a peer), tombstones apply by gid, unknown origins are
  quarantined.
- [x] **Node personalities beyond NET/ROM+BPQ** — `NODE_PERSONALITY` selects the node's command
  surface (`netrom` | `flexnet` | `tnn` | `baycom`): FlexNet-style destinations-with-RTT (a
  presentation mapping from NET/ROM quality — routing stays on the native metric), the TheNetNode
  command set with German-flavoured labels, and a terse BayCom-style box — one routing brain, the
  operator's preferred conversation.
- [x] **INP3 (Improved NET/ROM) routing** — triggered, point-to-point Routing Information Frames ranked
  by measured round-trip `tt` instead of NODES quality (`packages/packet/src/inp3.ts` + `inp3-table.ts`:
  RIF codec with ALIAS/IP options, L3RTT probe, RTT smoothing, best-tt table with horizon + withdrawal).
  Opt in via `NETROM_INP3=1`, alongside classic NODES so plain NET/ROM neighbours still interoperate. The
  live node bootstraps off NODES discovery — it adopts each broadcaster as a neighbour, seeds it with a
  self-RIP + an RTT probe, and advertises with split horizon, so two nodes converge with no static config
  (verified live over the AXUDP wire in the nightly interop loop).
- [x] **Shared compression dictionary** — the `deflateDict1` preset dictionary ships in
  `packages/shared` (immutable wire contract, versioned by capability id); the zlib codec around it
  lives at the ingest box (`apps/ingest`), where compact-tier RF links terminate — with a zip-bomb
  bound and an integrity-checked container so corrupt input fails decode instead of yielding wrong
  bytes.

## Deferred by design (reserved seams, opened on demand)

- [ ] **CI depth & deploy topologies** (next release) — boot the `deploy/` compose topologies in CI
  (full stack + ingest-only: `docker compose up`, wait for the gateway healthcheck, smoke `/health`
  + the SPA) beyond the current tri-runtime conformance (Node / Worker / Bun), and exercise the
  federation push-to-hub **rendezvous relay's** corroboration path. Also: full telnet-mode FBB
  forwarding in the nightly interop loop — register the partner user through the F6FBB sysop console
  (`xfbbC -c -r`) in the container so the telnet driver forwards end-to-end (the kernel-AX.25 leg
  already auto-creates users and exercises forwarding over the air).
