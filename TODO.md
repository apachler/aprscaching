# Launch list & deferred work

What ships is described in the product manual under [`docs/`](docs/); [`CHANGELOG.md`](CHANGELOG.md) records
each release from 1.0.0 on. This file holds two lists: the short **launch list** of what remains before the
1.0.0 tag, and below it the honest list of what is _intentionally_ left for after it — and **why**
each piece waits. It's a live checklist: an item leaves it when it lands. Nothing here is a known defect — defects
are fixed, not listed.

Each item carries a rough **priority · size** where useful — `P1`–`P3` (higher = sooner) and
`S`/`M`/`L` (effort). Deferred work is grouped by _why_ it waits, not by area.

## Before 1.0.0 — the launch list

Everything below this section is deliberately post-1.0. These items are in the tag because launch timing is what
makes them worth doing: contacts with outside programmes go out before the audience finds us, the public
instance and its legal pages must answer on the day, and a release artifact needs a release. They are listed in
start order: the first ones wait on replies from outside, so they start first, and the release itself is last.

- [ ] **Third-party contacts** _(S — start first, replies take time)_ — sent before the public launch, not after
      it. The trademark and non-affiliation lines they concern are live on the landing page, in Settings → Help &
      credits, in [`docs/about.md`](docs/about.md) and in the README.
  - [ ] POTA: a courtesy note to help@parksontheair.com about the spots and the park import.
  - [ ] SOTA: a post in the SOTA Reflector's **Third Party Software** category about the spots, the summit
        lookups and the region import, asking whether the request rates and the credit line suit the SOTA MT.
  - [ ] WWFF: ask directory@wwff.co for permission to show directory references; `wwff` stays refused until the
        operator names it in `IMPORT_ALLOW`.
  - [ ] IOTA: ask info@iota-world.org for permission beyond personal home use; `iota` stays refused the same
        way.
  - [ ] GMA: ask support@gma.rocks for an API key; GMA spots stay off until `GMA_API_KEY` is set.
  - [ ] Optional courtesy notes: ICSSW (oe3mzc@icssw.org) about MeshCom and the MeshMap credit, and
        OpenTopoMap, which asks to hear how its map is used.
- [ ] **OpenCaching import compliance** _(S — needs a reply in writing)_ — opencaching.de content is CC BY-NC-ND
      3.0 DE, and the German legal code is what the conditions below follow from. Its non-commercial test covers
      acts "nicht **vorrangig** auf einen geschäftlichen Vorteil oder eine geldwerte Vergütung gerichtet" — the
      direction of the act, not the identity or funding of the user — so recognition-only donations that never
      gate a feature do not make the import commercial. Its derivative clause puts collections outside the ND
      restriction outright: "Nicht als Abwandlung des Schutzgegenstandes gelten seine Aufnahme in eine Sammlung
      oder ein Sammelwerk." An unmodified import rendered as a collection therefore sits inside the licence; a
      transformed one does not. The importer keeps each cache's OKAPI `attribution_note` and owner and shows
      them with a link to the listing, and imported places never leave the instance: exports carry native
      caches only, and federation never re-exports them. A per-listing removal request is honoured, because the
      licensor of each listing is its owner, not the platform. Left: get the OKAPI consumer key through the
      self-service form at https://www.opencaching.de/okapi/signup.html, and ask Opencaching Deutschland e.V.
      (kontakt@opencaching.de, Cc verein@opencaching.de) to confirm this reading in writing; the email is for
      that confirmation only. Import stays off unless `OKAPI_BASE` + `OKAPI_KEY` are set, or an import request
      names a node's `{url, key}` (`workers/gateway/src/import/sources.ts`), so the tag ships without it if the
      reply is slow.
- [ ] **APRS tocall registration** _(S — needs a reply)_ — `APZACG`, the default tocall in the gateway, the
      ingest and the browser bridge, lies in the experimental `APZ` range, which aprs-deviceid reserves for
      development. `APRCG?` (`APRCG0`–`APRCGZ`) and a Mic-E identifier are requested in
      [aprsorg/aprs-deviceid#376](https://github.com/aprsorg/aprs-deviceid/issues/376); once allocated, switch
      the default tocall in the code to it.
- [ ] **Contact addresses exist** _(S)_ — the mailboxes behind `OPERATOR_EMAIL`, an abuse address and
      `security@aprscaching.net` exist and are read. Player reports land under Instance admin → Reports and are
      mailed to `OPERATOR_EMAIL` when mail is configured; the owner still names an abuse address on the imprint.
      `SECURITY.md` names `security@aprscaching.net`; the public instance sets
      `SECURITY_CONTACT=mailto:security@aprscaching.net` for its `/.well-known/security.txt`, and web push's VAPID
      contact is `VAPID_SUBJECT`, else `mailto:` `OPERATOR_EMAIL`, else the instance's https origin.
- [ ] **Imprint and privacy notice for aprscaching.net** _(S — owner and legal review)_ — `OPERATOR_NAME`,
      `OPERATOR_ADDRESS` and `OPERATOR_EMAIL` set, so `/imprint` meets ECG §5 (name, geographic address, email)
      and the MedienG §25 disclosure (owner: a small website, or a statement of the editorial line). Review
      `/privacy` (`workers/gateway/src/legal.ts`) against DSGVO Art. 13: the legal basis per purpose, the
      retention periods, the full list of rights, the Austrian Datenschutzbehörde as the supervisory authority,
      the processors (the email provider, and Cloudflare where used) with any third-country transfer, and
      server and proxy logs.
- [ ] **Sign-in mail deliverable** _(S)_ — the `EMAIL_FROM` domain has SPF, DKIM (the provider's selector) and a
      DMARC record (`p=quarantine` once the reports are clean); a sign-in link reaches Gmail, Outlook and GMX
      inboxes, not spam. The three records are documented in Sign-in links or Your first hour.
- [ ] **aprscaching.net live** _(M)_ — DNS points at the public instance; `INSTANCE`, `APP_URL` and `RP_ID` are
      `aprscaching.net` and the gateway answers on the same origin; `aprscaching.com` (and `www.`) answer `301`
      to `.net` at the edge, before any sign-in; TLS and HSTS checked; a passkey registered and used on `.net`;
      `/.well-known/source` names the running commit; `deploy/aprscaching doctor` reports no failure.
- [ ] **Backups of the public instance** _(S)_ — a scheduled backup with an off-box copy, and one restore
      rehearsed onto a scratch instance; `resources.backup` passes in the doctor.
- [ ] **Release pipeline proven** _(S — last)_ — _Allow GitHub Actions to create and approve pull requests_ is
      on, so release-please can open the release PR with `GITHUB_TOKEN`. Merge `dev` → `main`; check that the
      release PR proposes 1.0.0 and that its `CHANGELOG.md` entry lists only the commits after `bootstrap-sha`;
      merge it. Confirm the release carries the OCI stack zip, the
      desktop binaries, `SHA256SUMS` and the attestations, and that the README's "Deploy to Oracle Cloud" button
      resolves. Then merge `main` back into `dev`, so the version bump lands there.

## Needs hardware or a live partner (can't be validated headlessly)

These are blocked on physical radio, a real peer, or a network no CI runner has — not on code.

- [ ] **Pocket with a Bluetooth TNC in the phone's browser** — Web Bluetooth in Brave (enabled in
      `brave://flags`) with a BLE KISS TNC, and Termux:Boot autostart, are untested on a phone; the
      "tested on" table in [`docs/run/install/pocket.md`](docs/run/install/pocket.md) records what is.
- [ ] **MeshCom KISS on a real node** — the KISS link to a MeshCom node (`MESHCOM_KISS_PORT`, the node's KISS
      password in `MESHCOM_KISS_PASS`, answers sent through the node under the service call) is built and covered by unit tests, and is
      untested against node hardware ([`docs/run/radios/meshcom.md`](docs/run/radios/meshcom.md)).
- [ ] **Federation over FBB on a real BBS network** — `FED_BBS` (experimental, off by default) carries signed
      batches as personal mail to `ACSFED` at a partner marked for federation; the local AXUDP loop proves it
      between two aprscaching stacks, and nothing yet proves how F6FBB, LinBPQ or JNOS store, route or refuse
      that mail, or what a batch costs in airtime ([`docs/run/federation/fbb.md`](docs/run/federation/fbb.md)).
- [ ] **The packet terminal over a Bluetooth KISS TNC** — the terminal's BLE KISS connection, Mobilinkd's BLE
      KISS service included, is untested on hardware
      ([`docs/shack/packet-and-bbs.md`](docs/shack/packet-and-bbs.md)).
- [ ] **Owned-RF Tier A** — genuine Tier-A corroboration needs a receiver _you_ operate and attest for.
      The provenance seam is built and Tier A is designed-for; standing up the RF site is hardware, not code.
      Its amateur-IP reachability is a 44Net Connect address
      ([`docs/run/networks/44net.md`](docs/run/networks/44net.md)); an own 44Net PoP, the IPIP mesh and BGP are
      [decided, not planned](#44net-decided-not-planned).
      See [`docs/run/federation/index.md`](docs/run/federation/index.md) · [`docs/run/radios/rf-ingest.md`](docs/run/radios/rf-ingest.md).
- [ ] **Compressed FBB session against F6FBB** _(P2 · S)_ — run `fbb-forward.mjs` with `BBS_FORWARD_COMPRESS`
      against the interop F6FBB (`fbbcomp = OK 3`) and assert B1 negotiation and a compressed delivery.
- [ ] **Live-radio behaviour** — the pure codecs (KISS/AX.25, Meshtastic protobuf, CW/PSK31, CAT/`rigctld`,
      AXUDP/AXIP) are unit-tested; lighting them up on real hardware (a TNC, a rig, a raw-IP socket, off-air
      weak signals) is a field/deploy step by nature. See [`docs/run/radios/rf-ingest.md`](docs/run/radios/rf-ingest.md).

## Transport conformance (every connection path proven against a real partner)

The standing bar: each transport driver the box or browser can be configured to use gets one CI leg
where the counterpart is the reference implementation hams actually run — a unit-tested codec is
necessary but not sufficient (the AXUDP CRC trailer, `BROADCAST NODES`, and the FBB registration
gate each show up only against a real partner). The protocol × partner matrix in
[`tools/interop/README.md`](tools/interop/README.md) is the source of truth; every leg landing
updates it. Paths CI physically cannot host (Web Serial/BLE KISS, soundcard AFSK on air, real
radios) stay documented validate-at-deploy entries — visible, never silently absent.

Active scope is the core transports — KISS, AGWPE, APRS-IS and MeshCom, and every one runs: KISS TCP
against the kernel AX.25 stack, the full FBB mail exchange against F6FBB, APRS-IS against aprsc (all in
`interop.yml`), KISS TCP, AGWPE and the RX-IGate against two Direwolf modems over Bell-202 AFSK (the weekly
`transports.yml`), and MeshCom's golden-fixture conformance on Node and Bun (`pnpm
conformance:meshcom`; a live node stays validate-at-deploy). The local AXUDP loop, LinBPQ and TNN/JNOS legs
stay too: they guard the shipped NET/ROM node and FBB/BBS code.

**Parked conformance legs** — planned, not scheduled before launch; each is picked up when its
transport becomes core:

- [ ] **WA8DED hostmode vs tfkiss** _(P2 · M)_ — `tfkiss` (the TheFirmware emulator, the living
      Linux lineage of TFPCX) built from source, bridged onto the KISS leg; our hostmode driver runs
      its real TNC handshake, monitor headers, and channel polling against it.
- [ ] **AXIP raw IP proto 93 vs ax25ipd** _(P2 · M)_ — `ax25ipd` in `ip` mode as the partner, our
      `AxipPort` with the optional `raw-socket` dependency, CAP_NET_RAW on both containers. Completes
      the AXIP/AXUDP encapsulation pair against the reference bridge.
- [ ] **Meshtastic vs meshtasticd** _(P3 · L, experiment)_ — the official Linux-native/simulated
      node as partner for the serial protobuf framing; accepted-risk attempt, falls back to the
      hardware validate-at-deploy entry if the simulated radio path proves unstable in CI.
- [ ] **GPLSL driver conformance under Node** _(P2 · L)_ — the browser driver layer
      (hostmode/AGWPE/Multiport) is byte-stream-agnostic; run it headless in Node against the same
      Direwolf/tfkiss partners so ONE conformance suite covers the box drivers and the shack
      drivers alike.

## Station hub — parked until after launch

_The box as protocol driver + universal hardware interface (owner-decided design)._ Parked: it is a
separate product scope that carries transmit liability, and it does not advance the caching game.

The inversion of the transport work above: the box _consumes_ protocols; this program makes
it also _serve_ them, so third-party packet software uses our box as its TNC/driver (the TFPCX
role, over TCP/pty instead of a DOS TSR) — and drives every kind of shack hardware underneath.
One radio, many applications: every app sees RX, the hub arbitrates TX, and the platform ingest
taps everything that flows through. Decided scope: all three southbound servers, TNC2 emulation,
shared arbitration, core hardware through PACTOR, the full rig program including re-export, the full
PTT set, GPS, a separate hub daemon, weekly client-conformance legs, and fringe hardware last.

**Architecture** — new `packages/hub` (pure protocol/driver cores, unit-testable) + a separate
hub daemon process shipped in the same box image next to the ingest process: crash-isolated,
restartable, talks to ingest over the existing local seam. MIT-clean like the other packages.

**Southbound servers (what 3rd-party software connects to):**

- [ ] **AGWPE-TCP server** _(P1 · M)_ — the modern lingua franca (UI-View lineage, QtTermTCP,
      APRS clients): registration, monitor frames, raw frames, connected sessions.
- [ ] **KISS-over-TCP server** _(P1 · S)_ — universal fallback every packet program speaks;
      multi-client with per-client port filters.
- [ ] **WA8DED/TF hostmode server over TCP + pty** _(P1 · M)_ — the literal TFPCX/TFKISS role for
      Paxon/LinKT-class software: channel polling, monitor headers, autobaud prompt on the pty.
- [ ] **TNC2 command-mode emulation (`cmd:`) on telnet + pty** _(P2 · M)_ — vintage terminal
      programs get the classic prompt: C/D/MHEARD/MYCALL against our real stack.
- [ ] **Channel arbitration + monitor fan-out** _(P1 · M)_ — shared model: every connected
      app receives RX; TX serialized through a fair per-port queue with per-app budgets; session
      ownership tracked so connected-mode links stay coherent.

**Northbound hardware drivers (core hardware):**

- [ ] **Serial KISS TNC** _(P1 · S)_ — classic serial/USB KISS on the box (KISS over TCP is
      `apps/ingest/src/kiss.ts`, SMACK framing is in `packages/aprs/src/ax25.ts`; the browser reaches a USB TNC
      over Web Serial).
- [ ] **Supervised Direwolf** _(P1 · M)_ — the hub launches and manages a Direwolf instance
      (config generation, ALSA/pulse device pick, restart-on-crash) for soundcard AFSK/IL2P.
- [ ] **WA8DED hostmode TNC driver on serial** _(P2 · S)_ — TNC3/SCS-class firmware TNCs in hostmode on a
      serial port; the host-mode driver over TCP is `apps/ingest/src/hostmode.ts` (`HOSTMODE_HOST`).
- [ ] **SCS PACTOR hostmode** _(P2 · L)_ — PTC-II/P4dragon hostmode incl. PACTOR level
      negotiation; unlocks Winlink-grade HF forwarding through the same BBS/forward stack.

**Rig control, keying, position:**

- [ ] **rigctld client** _(P1 · S)_ — talk to an existing hamlib rigctld (net) for
      frequency/mode; band-tag everything the hub ingests. The client is `packages/aprs/src/rigctld.ts`, and
      its PTT keys the soundcard port (`apps/ingest/src/ptt/rigctld.ts`); frequency and mode are what's left.
- [ ] **Direct CAT serial drivers** _(P2 · M)_ — Icom CI-V, Kenwood, Yaesu protocol families for
      zero-dependency setups — the codec is `packages/aprs/src/cat.ts`, and its PTT keys the soundcard port
      (`apps/ingest/src/ptt/cat.ts`); frequency and mode from the box are what's left.
- [ ] **rigctld-compatible re-export server** _(P2 · M)_ — the hub serves the rigctld wire
      protocol so logging/digimode apps share the rig through us — same bridge idea as packet.
- [ ] **GPS/position sources** _(P2 · S)_ — gpsd client + raw NMEA serial feeding station
      position, beaconing, and the shack map.

**Conformance and fringe hardware:**

- [ ] **Client-side conformance legs in weekly `transports.yml`** _(P1 · M)_ — the mirror image
      of the interop suite: real third-party clients dial OUR servers in CI (Direwolf as AGW/KISS
      client, `call`/axcall via kissattach against our KISS-TCP, tfkiss-driven hostmode session,
      hamlib `rigctl` against the re-export). Every server above lands with its leg.
- [ ] **Fringe hardware** _(P3 · L)_ — LoRa RNode, RX-only SDR via rtl_tcp: roadmap-listed, attempted
      opportunistically after the core hardware.

## Native packaging

- [ ] **Watch: Bun on Android** — no official Android build (oven-sh/bun#28924), so Pocket runs the Node
      gateway rather than the desktop binary. Once Bun ships one, the desktop binary could run on a phone.
- [ ] **Watch: Android background limits** — Pocket relies on a wake lock, Termux battery "Unrestricted",
      and, where needed, _Disable child process restrictions_ (Android 14+). A new Android release that tightens
      background work, or removes that developer option, needs the keep-alive advice in the Pocket guide
      re-tested.
- [ ] **Watch: an RTL-SDR on Pocket** — not supported: neither `rtl-sdr` nor `direwolf` is a Termux package,
      librtlsdr cannot open a dongle from the file descriptor `termux-usb` hands over (the `rtlsdr_open_fd` patch
      on the osmocom-sdr list is not merged), and Direwolf needs ALSA or OSS headers that Termux lacks. Revisit
      when librtlsdr opens by file descriptor and Direwolf builds in Termux (or is packaged); then measure CPU,
      battery and heat over 30 minutes before offering it ([`docs/run/install/pocket.md`](docs/run/install/pocket.md)).
- [ ] **A later-corroborated find on mirrors** — a find lifted to Tier A by the later corroboration attempt
      keeps its first tier on instances that already mirrored it: a find takes its place in the origin's `find`
      sequence once, when it is logged, so a later change never reaches a peer. Re-serving a changed find needs a
      new sequence number on each change, as a cache takes on every edit (`fed_rev`).
- [ ] **Watch: DNS-PERSIST-01** — Let's Encrypt's standing DNS authorisation (one TXT record per name and
      ACME account, no new record per renewal) is not in production: it waits on an open point in the IETF
      draft. Once it ships, the ampr.org certificate ([`docs/run/networks/44net-identity.md`](docs/run/networks/44net-identity.md#tls-on-the-44net-name))
      can renew without a portal edit each time; lego already has `--dns-persist`.
- [ ] **Watch: FTDI, CP210x and CH340 TNCs on Pocket** — the USB KISS bridge drives only CDC-ACM devices;
      these chips need a userspace driver of their own over libusb. Worth doing when a common TNC needs it.
- [ ] **Capacitor mobile shell** _(P3 · L)_ — reuse the web app in a native iOS/Android wrapper for
      USB-serial / BLE-KISS and background operation. A build/sign/store pipeline, not a headless code core.
      The deployment shapes it would join are in [`docs/run/index.md`](docs/run/index.md).

## Growth & community (owner-decided slate; keeps the game-first orientation and the open/recognition-only style)

Next release:

- [ ] **Award ladder & endorsements** _(next release · P1 · M)_ — DXCC-style tiered awards for finds and
      hides (counts, Maidenhead grid chasing, distance records) with _endorsements_ by transport
      (RF-only / HF / Meshtastic) and an all-Tier-A prestige track; downloadable certificates,
      recognition-only. The proven stickiness engine of POTA/SOTA/DXCC, transplanted onto caching.
      Scoring substrate: **two ranking scopes** — instance (local rows, the club board) and network
      (local + mirrored signed records from trusted peers, Tier-A counted at the corroboration quorum).
      Each instance computes the network board from its own mirror — no central authority; rank by
      callsign with `account_id` aggregation, honor signed account-moves, show the scope as a segmented
      "This instance / Network" toggle with home-instance badges on network entries; instance awards
      issue locally, network awards claim when the trusted-peer quorum agrees.
- [ ] **FTF culture + streak souvenirs** _(next release · P1 · S)_ — a permanent first-to-find line on
      each cache's log (mono-callsign glory) plus daily/weekly find-streak souvenir badges.
- [ ] **Cache-centric watchlist triggers** _(next release · P1 · S/M)_ — HamAlert-pattern triggers on
      the existing watchlist + push/email-digest plumbing: new cache within X km / in grid Y, FTF still
      open, living cache activated nearby (a hider is already alerted when their cache is found).
The **Shack dashboard** (greyline, propagation, spots, award progress, kiosk) is scoped under _Tool ecosystem:
marketplace & dashboard widgets_ below.

Backlog (P3 unless noted):

- [ ] **SWL / receive-only mode** _(P2 · M)_ — an unlicensed account class that participates by
      reception (RTL-SDR / WebSDR / browser bridge in RX): reception-report logs, an own SWL ladder +
      leaderboard, never touching the licensed A/B/C find tiers. The license-conversion funnel —
      receive-only participation is an explicit invariant already, so nothing about the trust model waits
      on this. The first promotion candidate out of this list.
- [ ] **Seasonal "Support Your Caches" weekends** _(S)_ — quarterly themed event weekends with a
      participation certificate for everyone and plaque-style top recognition (the POTA
      support-your-parks pattern); federation peers can honor the same calendar.
- [ ] **Activator/hunter dual scoring for living caches** _(M)_ — SOTA-style points for both the
      portable station being the cache and its finders, feeding the award ladder.
- [ ] **Field Day "Cache Day" tie-in** _(S)_ — an annual event aligned with ARRL Field Day with a
      GOTA-style club bonus for supervised newcomer finds.
- [ ] **Club leaderboards & cache trails** _(M)_ — clubs as first-class entities: aggregate club
      scores and club-sponsored named trail series with completion certificates.
- [ ] **Weekly #CacheNet** _(S/M)_ — an ANSRVR-style recurring APRS-messaging net with map-visible
      check-ins and a check-in streak badge.
- [ ] **Elmer/mentor pairing** _(M)_ — opt-in mentor matching per region/topic with recognition
      badges for both sides; contact stays in-platform (thin, opt-in profiles).
- [ ] **Logbook sync (Wavelog/Cloudlog)** _(M)_ — builds on the QSO logbook (Future ideas): extend the ADIF
      export into a pull API the self-hosted logbook tools consume (they handle LoTW/eQSL/QRZ onward).
- [ ] **Winlink/SMS gateway UI** _(M)_ — friendly compose surfaces over the open APRSLink
      (Winlink↔APRS email) and APRS-SMS gateways from the messages surface.
- [ ] **Meshtastic cache mode** _(M/L)_ — caches discoverable and loggable over Meshtastic by licensed
      nodes only (licensed mode, callsign long name), with a distinct mesh provenance chip (always Tier C —
      a Meshtastic hearing is never attested RF) and an optional mesh leaderboard.
- [ ] **Post-ticket onboarding quest** _(S/M)_ — a guided achievement track for freshly-licensed
      hams: hear a packet → decode a frame → first gated beacon → first Tier-C/B/A find; pairs with the
      coach-mark tour.
- [ ] **Youth/event cache kits** _(M)_ — a packaged off-grid event-instance recipe (desktop single
      binary + printable/NFC cache kit + temporary scoreboard) for camps, school demos, and hamfests.

## Tool ecosystem: marketplace & dashboard widgets

The signed **Tools** plugin platform already carries what both programs build on: per-author Ed25519
manifest signatures, an authority-signed registry with a client-pinned key and a
`verified / known / self-signed / unsigned / invalid / key-changed` trust ladder, declarative panels
and map layers a sandboxed tool contributes without touching the DOM, and capability grants gated at
the host. Two programs extend it — a **dashboard surface** so a tool can contribute a widget, and a
**public tool bucket** so anyone can publish one. Breadth belongs in the bucket, not the core: the
first-party widget set stays small and excellent, and the long tail (satellites, cluster feeds,
aircraft layers) is what the marketplace is _for_.

The dashboard is the app release and it is scoped to one thing: a ham puts it on a screen in their
shack, with no account and no first-party server. The bucket is a separate repo on its own timeline —
only its in-package prerequisites touch a shipped build. Ordering that matters: the `ToolSurface`
rename lands before any new surface work and before the package becomes a contract third parties
compile against; the dashboard surface lands before the project's registry tools can declare it.

A bucket repo rather than a code monorepo or a publish service, because the binding constraints are
liability, bus factor, and running cost: entries are metadata pointing at author-hosted artifacts, so
listing never makes the maintainer the host of third-party code; the signed registry is a static file
any CDN serves, with no always-on authenticated infrastructure to die with its operator; and the
whole thing is forkable, so a community can clone and re-key it. It maps 1:1 onto the `RegistryEntry`
format that already exists.

Next release:

- [ ] **`ToolSurface` rename (prerequisite)** _(next release · P1 · S)_ — the tools package exports
      `Surface` (a tool's host surface) while `packages/shared/src/surfaces.ts` exports an unrelated
      `Surface` (the app's page sitemap), and `apps/web/src/tools/ToolPanels.tsx` imports the tools one.
      Rename the tools-package type to `ToolSurface` before the package becomes a public contract. Four files,
      mechanical, tests green.
- [ ] **Dashboard surface, widget nodes + kiosk workspace** _(next release · P1 · M)_ — add
      `dashboard` to the tool surfaces; a widget is a `PanelSpec` rendered on that surface, so the
      sanitizer, the sandbox, and the blind-router host apply unchanged. Three new panel node kinds
      (`clock`, `gauge`, `sparkline`) plus an optional `size` hint the host may ignore — the host owns
      layout, tools only hint; no images, iframes, or raw HTML. A shack workspace app arranges installed
      widgets in a grid, persisted like the nav pins. Kiosk mode (`?kiosk=1`, 800×480 up) is public and
      signed-out with a first-party default layout, so a shack Pi shows something with no account;
      personalised layouts need one. The source link stays in the kiosk footer.
- [ ] **First-party widget set v1 (feed-free)** _(next release · P1 · S each, four of them)_ — the
      widgets that need no backend at all: UTC/local clocks with sun and moon rise-set, the greyline
      terminator (deterministic solar math, host-side, and the emotional anchor of the whole surface),
      live cache spots, award progress. Two project registry tools join for the cost of a manifest line by
      declaring the new surface rather than being rewritten: `mheard` (recently-heard sparkline) and
      `watch-alert` (watchlist). The caching widgets are the differentiator — clocks and greyline are
      table stakes. Four times S is the real cost here; adding a fifth widget is a release decision, not
      a free one.
- [ ] **Pi / thin-client kiosk one-liner** _(next release · P1 · S)_ — an install script that puts a
      box into boot-to-dashboard kiosk, plus a recipes doc covering repurposed HamClock hardware, Android
      TV, Fire TV (browser, or a kiosk launcher for boot-to-app), and old tablets. One install command is
      the pattern those users already know, and it is how the migration actually happens.
- [ ] **HamClock-migration guide + positioning page** _(next release · P2 · S)_ — the displaced-user
      window is open: HamClock's original backend shut down in June 2026 and its users are picking a
      replacement. "Run it on the Pi your HamClock used — or on the TV you already own, free." Honest
      about OpenHamClock being complementary with a different centre of gravity. Ships with the dashboard
      or it misses the window.

Tool API gaps an author meets (each is described as it stands in [The sandbox API](https://apachler.github.io/aprscaching-tools/write/sandbox-api/)):

- [ ] **Tool commands and session events on the connected surfaces** _(P2 · M)_ — a tool's `/commands` run from
      the Tools console only, not from the packet terminal's, the BBS's or the node's command line, and no
      surface raises `on_connect` or `on_disconnect` or publishes `link.rtt`, so the session tools
      (auto-responder, away note, connect bell, info responder, link ping) have no live session to answer.
      `geo` has no API.
- [ ] **Session bridge from the ingest box** _(owner decision, after 1.0 · P2 · M)_ — the BBS and the NET/ROM
      node answer their connected sessions on the ingest box, where no tool runs, so a tool's connect events and
      remote commands never reach those sessions. Carry them ingest → gateway → the operator's browser and the
      tool's reply back the same way, under the remote-command rate limits a tool already has.

Tool registry gaps a sysop meets ([How registries work](https://apachler.github.io/aprscaching-tools/publish/)):

- [ ] **Author-key revocation** _(P2 · S)_ — removing an entry stops the registry vouching, but a
      browser that accepted a leaked author key keeps showing "matches the key you trusted before" for
      anything it signs. Add a signed `revoked` list of author keys to the registry that the import
      check refuses and that clears a matching trust-on-first-use pin.

Marketplace track (the `apachler/aprscaching-tools` repo on its own timeline; none gates the release):

- [ ] **Multi-pin registry authority** _(P1 · S)_ — a registry entry pins one authority key, so a
      rotation shows "key changed" on every instance and to every player until each confirms the new key. Let an
      entry pin a small allowlist (three or fewer), so a publisher announces the next key ahead of the
      rotation and confirmed pins keep verifying through the overlap. Cover the forged-authority rejection
      path — the whole registry trust model rests on `checkPinnedRegistry`.
- [ ] **Tool bucket + signed publish** _(P1 · M)_ — in the `aprscaching-tools` repo, one JSON
      file per tool under `bucket/`, so a pull request is single-purpose and pubkey continuity is a
      one-file diff. Validation reuses `@aprscaching/tools` (MIT and dependency-free precisely so it can):
      schema, live manifest fetch, a `valid` signature required for listing, independent `entrySha256`
      verification, HTTPS-only immutable `entry`, no pubkey change for an existing name outside a
      maintainer-approved rotation, and an automatic review label for the gated capabilities (`network`,
      `tx`, `beacon`, `geo`). Listed tools ship a readable, non-minified entry script so review audits the
      exact bytes the hash then freezes — human review is the enforcement, CI only flags obvious
      minification. Merge builds and signs `registry.json` from the bucket and deploys it to GitHub Pages from a
      reviewer-protected environment; an offline root key designates the online CI signing key, and its
      custody and rotation ship documented with the repo. Listings state a license. Wire
      `tools/toolkey/bundle-registry.mjs` into this repo's release workflow, so each release bundles the
      registry's latest tag rather than one copied by hand.

Backlog (P3 unless noted) — the first three are what a second dashboard release picks up:

- [ ] **Feed proxy v1 + feed-backed widgets** _(P2 · M)_ — widgets must not each hit upstreams from
      every browser. A scheduled server-side fetch and cache exposes versioned `/api/feeds/*` under the
      free read API (the Node/Bun interval, a SQLite cache table), and a first-party feed tool
      re-exposes it over the host IPC bus, so a third-party widget needs no `network` grant for curated
      data — which is what keeps that grant meaningful. Every response carries source and fetched-at so a
      widget labels stale data by age; every feed gets a circuit breaker and stale-while-revalidate,
      because the POTA API is unofficial and can break without notice — a widget shows old data with its
      age, never a blank panel.

  **Shared feed by default, direct polling as an opt-in.** Self-hosting means every instance would
  otherwise become another client at an upstream that never agreed to serve a network. So an instance
  defaults to consuming a shared feed origin and MAY opt into polling upstream itself — which an
  off-grid or fully autonomous instance needs. The origin is a _role, not a service we own_: the
  serving code ships in every instance, the feed contract is published, and any instance can be the
  origin for a group, so the arrangement has no operator to outlive. Federation is deliberately NOT
  the carrier for this — relaying upstream data over signed frames that peers forward unchanged is
  redistribution that cannot be recalled, and it is precisely what the OpenCaching conditions forbid
  and what the courtesy contacts promise not to do.

  **A feed is shared only if its upstream permits redistribution**; otherwise every instance polls it
  directly, keeping its own politeness floor, and it stays off by default. NOAA space weather is US
  public domain and shareable; the contest calendar is published for reuse; POTA and SOTA spots are
  direct-poll-only unless those programmes say otherwise in writing — the courtesy contacts ask them
  exactly that, and SOTA's data additionally sits under the UK database right. Held out of the first
  dashboard release on purpose: it is the only server-side piece in the program and the only one with
  a standing upstream-maintenance cost, and the dashboard is worth running with no first-party server
  at all — that property is the answer to how HamClock died, so it ships proven first.

- [ ] **10-foot TV mode** _(P2 · S)_ — a kiosk variant for a TV across the room: large type,
      overscan-safe margins, no pointer or hover dependency, and a burn-in guard (slow pixel shift plus a
      dim schedule). One mode covers Fire TV, Android TV, and the Samsung/LG browsers. A free web route is
      the deliberate answer to the paid TV app the community backend sells.
- [ ] **Kiosk pairing code** _(P2 · M)_ — a headless display opens `/tv` and shows a six-character
      code; an operator claims it from a signed-in device and the display loads their layout. Account
      prefs are the transport, no new protocol. Kills D-pad URL typing, the single biggest smart-TV
      usability barrier — pairs with TV mode, not before it.
- [ ] **Tool update flow** _(P2 · S)_ — the Tools console diffs the installed version against the
      registry entry and offers a one-click re-import; a scheduled bucket workflow opens an auto-pull-
      request when an author's hosted manifest is ahead of their entry.
- [ ] **Satellite passes widget** _(M)_ — TLE-based; a marketplace candidate first. If it lands
      first-party, the TLE feed is signed and provenance-labelled: a cache-poisoning incident in a
      comparable project is exactly why data gets signed, not only code.
- [ ] **Band conditions v2 (VOACAP-class)** _(L)_ — real propagation prediction; v1 is a simple
      index-derived band table off the solar feed.
- [ ] **RSS/news widget** _(S)_ — server-side title extraction on a curated ham-news list, plain
      titles to the client.
- [ ] **Box telemetry widget** _(M)_ — ingest-box temperature, voltage, and GPIO over the existing
      remote relay, onto the dashboard.
- [ ] **Big Clock mode** _(S)_ — a single-widget-maximised kiosk state.
- [ ] **Feed API as a published contract** _(S, doc)_ — a versioned public spec so other shack
      displays can consume our feeds. An open contract is the opposite of the closed-backend failure that
      killed HamClock.
- [ ] **Native TV apps (Fire TV / Android TV)** _(M, demand-conditional)_ — a thin WebView wrapper on
      the Amazon and Google stores, only if the web kiosk demonstrably falls short for TV users. Never
      paid — the recognition-only invariant holds here too.
- [ ] **Legacy HamClock backend compatibility** _(L, parked)_ — speaking the community
      client↔backend protocol so an orphaned HamClock can point `-b` at an instance. Parked: revisit only
      if the community backends falter and the feed proxy already covers most of the data products.

## Future ideas

- [ ] **Visiting finds: log another instance's cache from your home instance** _(P1 · L)_ — a mirrored cache
      is read-only (`docs/play/find-a-cache.md`, *Caches from other instances*): only the cache's home instance
      holds the rules that score a find (its minimum tier, its receiving stations, stage coordinates and NFC
      unlocks) and keeps the one logbook, so a player needs an account on every instance whose caches they hunt.
      The player logs the mirrored cache at home; the find travels to the cache's home instance as a signed
      federation frame: the authorship signature the app already makes per find, the device reading as
      evidence, the player's published callsign key and the home instance's statement of callsign verification.
      The cache's instance accepts it only from a trusted peer (a find from an unvetted peer is quarantined),
      checks the signature against the key feed, applies its own find rules and grades it from its own evidence
      (Tier A only from its own attested receivers; the home instance's verification counts as far as the peer
      tier allows). It shows as a visitor's find, falls under the cache instance's moderation, and federates back
      like any find. Needs: a frame kind and its `admitFrame()` rules, a queue on the sending instance while the
      cache's instance is unreachable, and the sheet saying the find is on its way. Open: how visitors rank on
      each instance's leaderboard, and rate limits per peer. Transport never lifts trust: the tier is the cache
      instance's.
- [ ] **Guided move to another instance** _(P2 · M)_ — moving an account exists only as API calls
      (`/api/account/<call>/bundle`, `/move`, `POST /api/account/import`, `workers/gateway/src/account.ts`), with no
      UI. Add **Settings → Your data → Move to another instance** (enter the new instance, build and sign the bundle
      with the device key) and **Bring my account from another instance** at sign-up on the target. Lock the old
      account with a pointer to its new home (check what the source does today), carry settings and the watchlist,
      and offer owned caches for adoption on the old instance or move them when both sysops agree. The callsign
      lands unverified by design; passkeys cannot move (bound to their domain).
- [ ] **How a station was heard, on the map** _(P2 · M)_ — the station panel and the pins name no transport
      for APRS: track replay says RF or IS, and only a MeshCom hearing has its own panel section. Show a "Heard
      via" line and a badge (APRS-IS, RF on a TNC, MeshCom) and let the Nearby list filter by it. The gateway
      stores the transport per position; the stations query, `StationSummary`, the live `StationDelta` and
      `envelopeForPosition` do not carry it. Display only: no tier changes.

- [ ] **Rig control through the ingest box (Hamlib)** _(P2 · M)_ — the Shack tunes only the three CAT families it
      speaks over Web Serial; Hamlib's `rigctld` covers 200+ radios, but a web page cannot open its TCP port (4532).
      The ingest box bridges it, with Hamlib never linked (it is (L)GPL; `packages/*` stay MIT):
      - **Box:** new settings `RIGCTLD_HOST` / `RIGCTLD_PORT` (default `127.0.0.1:4532`) in
        `packages/shared/src/configkeys.ts` + `configdocs.ts` (`node tools/config/generate.mjs`). The box opens the
        TCP link and drives `RigctldClient` (`packages/aprs/src/rigctld.ts`, the transport's `send(line)` resolves
        with the daemon's reply); it reports `rig` in its capabilities on the commands poll (`apps/ingest/src/boxpoll.ts`
        query, gateway `BoxCaps` in `workers/gateway/src/box.ts`).
      - **Commands:** a box command kind `rig_tune {hz, mode?}` enqueued by the gateway and handled in the
        `boxpoll.ts` switch beside `aprs_msg` / `meshcom_msg`; the result (frequency read back with `f`) returns on
        the next poll. Owner-only, the same rule as the remote box (`docs/run/radios/remote-box.md`).
      - **Shack:** **Rig control** gets a third connection, **Through my box (Hamlib)**, shown when the signed-in
        account has a box reporting `rig`; it works on iOS and non-Chromium browsers, since no Web Serial is involved.
      - **Never PTT:** frequency and mode only. `T` (keying) stays unwired, as transmit is gated on callsign
        control-verification and the box is not a transmit path for the Shack. (The Station hub's PTT item keys
        the hub's own transmit ports, a separate path.)
      - Docs: `docs/shack/rig-weather.md` (the option), `docs/run/radios/ingest-box.md` (the settings, running
        `rigctld -m <model> -r <port>` beside the box), `docs/reference/rig-library.md` (the client's user).
      The Station hub's parked **rigctld client** item above is the same client from the hub side.

- [ ] **A dark vector basemap** _(P3 · M)_ — the online basemap (OpenFreeMap "liberty") is light in every theme,
      so a dark or Phosphor app opens onto a bright map. A dark style from the same tiles would follow the
      Appearance setting; the offline grid map already does (`--map-graticule-*`). It needs a style the operator
      can self-host beside the tiles, chosen at style-load time by the applied theme, and the cache and station
      pins checked for contrast on it.

- [ ] **OCI warm standby (HA)** _(P3 · L)_ — a second instance that takes over when the OCI VM dies, still
      inside the free tier. What the free tier offers: the A1 allowance (2 OCPUs / 12 GB) splits into two 1 OCPU
      / 6 GB VMs; two E2.1.Micro VMs; one Network Load Balancer; one flexible Load Balancer at 10 Mbps. The
      constraints decide the design:
      - SQLite has one writer, so it is **active + warm standby**, never active-active. Federation does not
        help: it does not replicate accounts, sessions or finds.
      - Replication: Litestream to the bucket at its default one-second sync would exceed 50,000 requests a
        month; replicate over SFTP to the standby instead, or sync far less often.
      - Failover: the NLB with exactly one healthy backend, or a watchdog that moves the reserved IP to the
        standby (a reserved IP can move between private IPs in the region).
      - TLS: both nodes need the certificate, so DNS-01 on both.
      - The ingest (APRS-IS login, RF) runs on the active node only.
      - A passive standby meets idle reclamation, so it needs Pay As You Go; both nodes need A1 capacity.
      - Alternative: containers on Pay As You Go, which still need persistent storage.

- [ ] **FCC ULS email verification** _(S/M · blocked on a data source)_ — verify a US call by mailing a code
      to the address the licensee gave the FCC, storing only `sha256(lowercased email)` per call. Blocked: the
      public amateur bulk file (`data.fcc.gov/download/pub/uls/complete/l_amat.zip`, `EN.dat`) carries the
      Email column (field 15 of the 30-field EN record) empty for every record, so there is nothing to import.
      Needs a source that publishes the address, kept separate from the licence-validity registry importer.
- [ ] **LoTW certificate revocation** _(S)_ — consult LoTW's certificate status service (tqsllib queries
      `https://lotw.arrl.org/lotw/crl?serial=`) before accepting a callsign certificate, so a replaced or
      revoked certificate stops verifying.

- [ ] **Retro read-only access** _(P3 · M)_ — small Node daemons (raw TCP/TLS, beside the gateway's HTTP) exposing
      caches-near / station info / leaderboard over **Finger**, **Gopher**, and **Gemini**. Fits the
      "it's a network" ham-retro aesthetic.
- [ ] **Ham-radio QSO logbook** _(P3 · M)_ — a worked-stations log (band/mode/freq/RST/grid) with **ADIF**
      import/export and optional LoTW/eQSL/QRZ sync, distinct from the cache logbook.
- [ ] **Live-room region sharding** _(P3 · M)_ — shard the live WebSocket room by geohash so fan-out scales
      past a single global room.
- [ ] **One-click POI overlay** _(P3 · S)_ — a map-side toggle that live-queries a curated OSM/Wikidata set
      (peaks, castles, lighthouses) for the current viewport as a switchable layer, respecting each source's
      attribution.
- [ ] **Native Meshtastic transports at the ingest box** _(P3 · L)_ — BLE and USB serial at the box, with
      the same licensed-only rule as the node TCP API and MQTT protobuf feeds it reads (the browser path
      already does Meshtastic over Web Serial).
- [ ] **MeshCom follow-ups** _(P2 · M)_, in order:
  - bench-test the MeshCom ack for radio commands (`SENDER   :ack<nnn>` handed to the hearing node) on a
    real node ([design](docs/contribute/design/radio-find-logging.md));
  - `tele` → the observational weather path with a per-field presence rule (the firmware reports an
    absent sensor as `0`);
  - replies from the Messages surface to a MeshCom direct message, sent through `MeshcomSender`;
  - sending to a MeshCom group from the Messages surface (the group view is read-only), opt-in per group and
    rate-limited, if operators ask for it;
  - `rssi`/`snr` as a presence-plausibility signal alongside a direct hearing;
  - a HAMNET-hosted aggregator for several operators' nodes, each attested separately;
  - a browser-direct Web Serial/BLE path, after reading the node's serial and BLE protocols from the
    MIT firmware.
  - **Watch: automatic via selection and Hey!-based routing** — the firmware's automatic via is commented out
    "for testing" since 2026-07-22 (still so in 4.40a). The disabled code picks the gateway token `HG` on a
    gateway and otherwise the direct neighbour heard within 60 minutes that reports the most neighbours. Once
    it returns, via lists appear without operators setting them, and destinations such as `HG` may reach
    ExtUDP; check the destination rules and the fixtures against it then.
  - A network-wide feed from the MeshCom servers is not pursued (owner decision): the map shows what the
    operator's own node(s) heard and links to MeshMap for the rest
    ([guide](docs/shack/live-map.md#meshcom-on-the-map)).
  - **Caches on the MeshCom map** ([research](docs/contribute/design/meshcom-tdeck-map.md)) — display only, never
    find evidence. The T-Deck Plus needs firmware 4.35t or later (the screen-rendering fix).
    - [ ] **`CACHES` bot command** _(P2 · M)_ — a MeshCom operator sends `CACHES [grid]` to the bot call
          and gets the nearest caches in one ≤150-byte reply (sender's last beacon when no grid). _Why:_ works
          on every MeshCom node as shipped, no firmware change. _Notes:_ same command engine and reply path as
          [radio find logging](docs/contribute/design/radio-find-logging.md); rate-limited per sender. _Impact:_ first
          way to discover caches from a handheld without a phone. _Depends on:_ —
    - [ ] **GPX/CSV cache export per region or grid square** _(P2 · S)_ — `/api/v1` export of caches
          within a Maidenhead square or region in the waypoint format the SD-card overlay reads. _Why:_ feeds
          the overlay and any GPS/mapping tool. _Notes:_ `/api/v1/caches.gpx?bbox=` exists; add `grid=` (a
          Maidenhead square resolved to its bbox) and a CSV variant (`lat,lon,label,symbol`, label = cache
          code). _Impact:_ offline cache sets for the
          field. _Depends on:_ —
    - [ ] **Upstream proposal: SD-card waypoint overlay** _(P2 · S proposal / L firmware)_ — agree with
          ICSSW, then file the drafted issue. _Why:_ offline, zero airtime, generic (repeaters, SOTA,
          shelters). _Notes:_ draft in the research page; the map draws SD-card tiles with LVGL, so the overlay
          reuses its projection and keeps its own table apart from the 30-station ring. _Impact:_ caches on the
          device map without any transmission. _Depends on:_ the grid export.
    - [ ] **Upstream proposal: show received APRS objects on the map** _(P3 · L)_ — a new MeshCom object frame
          type, with expiry and kill-frame support. _Why:_ the dynamic half of the overlay; MeshCom has no
          object frame, so the firmware discards objects. _Notes:_ draft in the research page.
          _Impact:_ events and new caches appear live. _Depends on:_ —
    - [ ] **Upstream proposal: KISS object frames from the client's own call** _(P3 · M)_ — _Why:_ lets a
          client announce objects under the operator's callsign. _Notes:_ draft in the research page; keep
          the own-callsign check and rate limit. _Impact:_ enables the on-demand object bot. _Depends on:_
          object display on the map.
    - [ ] **On-demand cache-object bot** _(P3 · M)_ — on request, the nearest 3–5 caches as APRS objects
          (name = cache code, originator = bot call); never beaconed; per-sender rate limit and per-area
          cooldown. _Why:_ map pins instead of a text list. _Impact:_ caches on every nearby node's map.
          _Airtime:_ every node repeats objects, so on-request only. _Depends on:_ the `CACHES` bot command and
          both upstream firmware changes.
    - [ ] **T-Deck Plus test device** _(P2 · S)_ — buy the 433 MHz variant with external antenna, flash
          MeshCom via the ICSSW web flasher, document the setup in the operator guide. _Why:_ a reference
          handheld for every item above. _Depends on:_ —
    - [ ] **Measure free memory with the map open** _(P3 · S)_ — heap and PSRAM on a T-Deck Plus, with `--heap`
          on a measurement build. _Why:_ sizes the overlay's point cap. _Notes:_ the other firmware questions
          are settled from the 4.40a source (research page). _Depends on:_ the T-Deck Plus test device.
    - [ ] **Upstream issue: southern and western positions on the T-Deck map** _(P3 · S)_ — the function that
          adds a station to the map, and the one that fills the position list, negate latitude for `W` and
          longitude for `S`, so neither is negated (`tdeck_add_pos_point`, `tdeck_add_to_pos_view`).
          _Why:_ stations outside the northern and eastern hemispheres plot in the wrong place. _Notes:_ a
          one-line fix in each function; the issue is drafted in the research page
          ([draft](docs/contribute/design/meshcom-tdeck-map.md#draft-southern-and-western-positions-on-the-t-deck-map)),
          to file on icssw-org/MeshCom-Firmware. _Depends on:_ —
- [ ] **Bring-your-own-ingest, self-service** _(P2 · M)_ — a member binds their own box without a sysop
      enrollment code, and a box whose 44net-verified hostname passes the DoH/DNSSEC binding check gets its
      sites trusted automatically. Enrolled boxes and sysop-approved lent receivers (Instance admin → Ingest
      boxes) already cover the manual path. Tier A stays gated on attestation, never on transport.

- [ ] **Station packs for offline use** _(P3 · M)_ — an offline pack also carries the digipeaters, IGates, MeshCom
  nodes and BBS contacts of its square, for EmComm exercises and for knowing where to beacon with no data. Builds
  on the locator packs (`GET /api/offline/pack`) and the station read APIs.
- [ ] **Offline cache drafts** _(P3 · M)_ — hide a cache on site with no connection: a draft with measured
  coordinates, photos (scaled and thumbnailed in the browser, as uploads are) and text, kept in IndexedDB and
  submitted for publishing when back online, with its media uploaded then. The submit is a hide like any other:
  a verified callsign and the account's daily hide limit apply at that moment.

## Legal & attribution

- [ ] **APRS mark re-check** _(S)_ — the credits name the APRS® mark by its USPTO registration (U.S. Reg.
      No. 2058846) and no holder, and say APRScaching is not affiliated with or endorsed by whoever holds it. The
      registration's renewal is due on 6 May 2027: re-check the record after that date, and drop the ® from the
      credit lines if it lapses.
- [ ] **Vendor the third-party test partners (interop peer registry)** _(M)_ — every partner the
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
    JNOS). The linbpq image already prefers the Hibbian repo with the
    download-at-build as fallback, and the TNN/JNOS source fetches pin immutable commit
    archives (the commit hash is the version pin; the `*_SHA256` args stay operator
    overrides) — the remaining work is the GHCR image registry itself.

## Engineering-quality follow-ups (opportunistic, not defects)

- [ ] **Run the live mic decode e2e for real** _(P2 · S)_ — the `e2e-audio` CI job installs Chromium with
      `playwright@1.61.1`, whose revision the repo's `playwright-core` 1.63 does not look for, so
      `tools/e2e/audio-mic.mjs` prints SKIP and passes without running. Run against a real Chromium, its PSK31
      decode comes out garbled and different on every run (`" cqde t s nd  teat  q"` for `cq de test`). Fix the
      decode path (or the synthesised signal's timing), then install the browser with
      `pnpm exec playwright-core install --with-deps chromium` and fail on a missing browser in CI, as the
      `e2e-offline` job does.
- [ ] **Tighten the type-aware warnings** _(P3 · M)_ — promote `lint:types` warnings to errors rule-by-rule
      as the code is cleaned. **Errors:** `require-await`, `unbound-method`, `no-base-to-string`, and
      `restrict-template-expressions` are **errors** (the legitimate exception — a data property named
      `apply` — is a per-file override in `eslint.config.types.mjs`).
      Untrusted request-body fields are coerced through `asStr()` (gateway `http.ts`) / a local equivalent
      (`packages/tools`) at every boundary, so a malformed body can never stringify to `[object Object]`.
      **Left:** `no-unnecessary-type-assertion` stays a **warning** — it false-positives on generic
      `.json()`/`unknown` returns under `projectService` (auto-fixing it would strip load-bearing casts).
- [ ] **A preinstalled Raspberry Pi image** _(P3 · L)_ — a ready-to-flash image with the Self-host stack
      and the deploy helpers, so a Pi needs no setup beyond `deploy/aprscaching init selfhost`. It is a large
      build and maintenance effort (image builds per release, updates of the base system), so it waits until the
      helpers have settled on real installations.
- [ ] **One audit trail for sysop actions** _(P2 · S)_ — a claim or release of a callsign is written to
      `callsign_events`, beside `account_events` (manual verifications) and `cache_adoptions` (hand-overs), apart
      from the moderation audit log (`moderation_log`, Instance admin → Moderation). Fold them into it, keeping
      each table's erasure rule (the person's account and the sysop's note go, the row stays).
- [ ] **Sign back in after losing a passkey-only account's last call** _(P2 · S)_ — an account whose only
      callsign its licensee took over signs in again with an email link and the call it operates now. A
      passkey-only account has no such path: passkey sign-in starts from a callsign. Discoverable-credential
      sign-in (no callsign typed) would let it in to add a call; until then the sysop helps.
- [ ] **Re-serve moved finds to peers** _(P3 · M)_ — finds that move off a claimed call with their account are
      tombstoned on peers, because a find takes its `find` sequence number once and is never served again. Peers
      then lose those finds instead of showing them under the account's remaining call. Finds numbered anew on
      each change, as caches are, would carry them across (the same change as the later-corroborated find above).
- [ ] **Move the gateway app out of `workers/`** _(P3 · M)_ — `workers/gateway` (`@aprscaching/gateway`) holds the
      runtime-neutral gateway app the Node and Bun servers share, not a Worker. Rename it to `packages/gateway` or
      `core/gateway` — the directory, the package name, every import, the CI paths, the Dockerfiles and the manual —
      in one change after 1.0, when the churn costs no release. Its database shim names (`d1.ts`, `makeD1`) go with
      it.

## Federation hardening

Each finding and its status is tracked in
[`docs/reviews/federation-validation-2026-09.md`](docs/reviews/federation-validation-2026-09.md); every fix
lands with a regression test that fails without it.

- [ ] **Hide one mirrored cache or find from a peer** _(P2 · M, after 1.0)_ — the sysop's **Remove…** reaches
      this instance's own records and bulletins mirrored from peers, but not a single cache or find mirrored from
      a peer: the sysop asks the peer's operator or blocks the whole peer under **Federation**. Add a
      local suppression keyed to the record's global id (the way a removed mirrored bulletin is suppressed), so
      the item leaves the map, search and offline packs here, a later sync skips it, and the audit log records
      it; the peer keeps its copy.
- [ ] **Registry DNS lookup through `DOH_URL`** _(P3 · S)_ — `FED_REGISTRY_DNS` always asks Cloudflare's
      resolver (`federation.ts` `registryFromDns`), unlike 44net onboarding and `ampr.org` verification,
      which use `DOH_URL`. _Why:_ an instance on HAMNET without the internet cannot locate its registry by DNS;
      `FED_REGISTRY` (a document URL) is the workaround.

## Federation over RF

The CBOR signed wire format, typed peer endpoints, the two-tier transport seam (sync +
store-and-forward), and ARDC-verified 44net onboarding are built — see
[`docs/reference/federation-wire.md`](docs/reference/federation-wire.md). What rides on them next:

- [ ] **Per-origin sync over packet circuits** _(P2 · M)_ — a circuit pulls only the peer's own feeds
      (each starting at the gateway's per-origin mark when that is further). Asking for "origin Y after N" over
      `ACSL1` needs a summary request on the circuit (a new line type beside `R`, `origin` in the request map)
      and a gateway endpoint that takes an ordered origin page from the ingest box as the answer to one request,
      applying it as `pullOrigin` does; `POST /federation/frames` takes frames from any carrier in any order, and
      a mark moved by the box's session report would let that report decide what the gateway holds
      ([`docs/reference/federation-wire.md`](docs/reference/federation-wire.md#connected-mode-sync-ax25-net-rom-circuits)).

## 44Net: decided, not planned

44Net is used for reachability (a 44Net Connect address) and identity (`<call>.ampr.org`), never for trust
— see [`docs/run/networks/44net.md`](docs/run/networks/44net.md). These were weighed and are not planned, each for
the reason given:

- **BGP announcement of a 44Net /24** — solves routing for one operator, not identity or trust; it needs a
  /24, a BGP-capable provider and a letter of authority, and 44Net space has no RPKI to lean on.
- **An own ASN** — identity is keys; an ASN says nothing about which ham runs a box, and brings fees,
  multihoming and BGP operations.
- **Anycast for federated instances** — anycast needs identical state behind every address; a Self-host
  instance behind Cloudflare's proxy is already reached through a global anycast edge.
- **IPIP mesh / amprgw / ampr-ripd** — legacy, complex and low-bandwidth; 44Net Connect gives the same
  reachability with a standard WireGuard client.
- **In-app WireGuard or 44Net Connect management** — tunnels and routing are the operating system's or the
  router's job; the app never holds tunnel keys or changes routes.
- **Automated ARDC Portal / Connect provisioning** — no public ARDC API for it was found; the manual steps
  are short (see the watch item below).
- **Trust or identity from a source address** — an address is not a signature; deriving either from it
  would break "transport is not trust".
- **Encryption over HAMNET RF** — not allowed on amateur radio; everything that crosses RF is signed, never
  encrypted.

- [ ] **Watch: 44Net Connect inbound policy and an ARDC provisioning API** — ARDC documents Connect
      addresses as reachable from the internet and unfiltered (checked 2026-09-30); a change to that policy
      changes the reachability section of the 44Net page and its firewall advice. Also watch for a public API
      for Portal DNS records or Connect tunnels: the Portal API documents only IPIP-mesh routes, and Connect's
      API keys have no public reference. An API would let the self-check print a one-click fix, and would
      reopen the provisioning item above.

## Deferred by design (reserved seams, opened on demand)

- [ ] **CI depth & deployment shapes** _(P2 · M)_ — boot the `deploy/` compose stacks in CI
      (full stack + ingest-only: `docker compose up`, wait for the gateway healthcheck, smoke `/health`
      and the SPA) beyond the runtime conformance (Node / Bun).
