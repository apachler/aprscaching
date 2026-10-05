# Launch list & deferred work

What ships is described in the product manual under [`docs/`](docs/); [`CHANGELOG.md`](CHANGELOG.md) records
each release from 1.0.0 on. This file holds two lists: the short **launch list** of what remains before the
1.0.0 tag, and below it the honest list of what is _intentionally_ left for after it — and **why**
each piece waits. It's a live checklist: boxes get ticked as items land. Nothing here is a known defect — defects
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
- [x] **Protect `main`** — the `main` ruleset blocks deletion and force pushes and requires a pull request (no
      approvals; squash and merge allowed), so only the release PR and `dev` → `main` merges reach it.
- [ ] **aprscaching.net live** _(M)_ — DNS points at the public instance; `INSTANCE`, `APP_URL` and `RP_ID` are
      `aprscaching.net` and the gateway answers on the same origin; `aprscaching.com` (and `www.`) answer `301`
      to `.net` at the edge, before any sign-in; TLS and HSTS checked; a passkey registered and used on `.net`;
      `/.well-known/source` names the running commit; `deploy/aprscaching doctor` reports no failure.
- [ ] **Backups of the public instance** _(S)_ — a scheduled backup with an off-box copy, and one restore
      rehearsed onto a scratch instance; `resources.backup` passes in the doctor.
- [x] **Docs current with the code** — the manual, this file and the changelog match what `dev` ships: trusted
      receiving stations, media limits and offline tiles in the API reference, every migration in the data
      model, the player pages.
- [x] **CHANGELOG starts at 1.0.0** — `CHANGELOG.md` holds no pre-release history: release-please reads only
      the commits after `bootstrap-sha` in `release-please-config.json`, and a commit after it carries the
      `Release-As: 1.0.0` footer.
- [ ] **Release pipeline proven** _(S — last)_ — _Allow GitHub Actions to create and approve pull requests_ is
      on, so release-please can open the release PR with `GITHUB_TOKEN`. Merge `dev` → `main`; check that the
      release PR proposes 1.0.0 and that its `CHANGELOG.md` entry lists only the commits after `bootstrap-sha`;
      merge it. Confirm the release carries the OCI stack zip, the
      desktop binaries, `SHA256SUMS` and the attestations, and that the README's "Deploy to Oracle Cloud" button
      resolves. Then merge `main` back into `dev`, so the version bump lands there.
- [x] **Privacy-first APRS-map positioning** — the four invariants that differentiate us from incumbent
      APRS maps are stated where a visitor and an operator each meet them: a _What we do with your beacons_
      section on the landing (`apps/web/src/Landing.tsx`), and _Privacy by default_ in
      [`docs/about.md`](docs/about.md), which names the code behind each claim. TTL'd positions (firehose and
      browser-RF pruned nightly, corroborating fixes kept as a find's evidence), no analytics/advertising/
      third-party trackers, the AGPL §13 source link, and self-hosting on your own hardware.
- [x] **Coach-mark tour content** — the find flow, map → cache detail → log a find, in
      `apps/web/src/ui/tourSteps.ts`, with a closing step that differs for a visitor and a signed-in cacher.
      Steps anchor on `data-tour` hooks rather than style classes, so restyling the chrome cannot silently
      unanchor the tour, and `apps/web/test/tour-anchors.mjs` fails the build if a step and its hook part
      company. `Tour.tsx` rings the anchored element and places the card against it with CSS anchor
      positioning, falling back to its centred dialog wherever the element is absent (a first run has no cache
      open) or anchor positioning is unsupported.
- [x] **Hosted OCI one-click stack** — `scripts/build-oci-stack.sh` packages `deploy/oci/` flat (Resource
      Manager reads `main.tf` and `schema.yaml` from the zip root) and `.github/workflows/oci-stack.yml`
      attaches it to every release (release-please calls it), so the "Deploy to Oracle Cloud" button resolves
      `releases/latest/download/aprscaching-oci-stack.zip` with nothing to upload by hand. Each release's zip
      pins its own tag into `repo_ref`. The stack builds its own VCN/subnet/gateway and resolves the Ubuntu
      aarch64 image itself, so it never asks for an OCID; `schema.yaml` drives the console prompts and
      `tools/checks/oci-stack.mjs` fails CI if the variables, schema, cloud-init placeholders and packaging
      script drift apart.

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
- [x] **FBB LZHUF (B0/B1) compressed forwarding + MD5 link auth** — the codec is built and **byte-exact
      against a real F6FBB oracle** (`packages/packet/src/lzhuf.ts`: N=2048 window, F=60, classic 6+6 position
      tables, B0 `[LE32 size]` framing, B1 `[LE16 CRC][LE32 size]` framing over the TransIt CRC-16). The
      **binary-block session transport** is built (`fbb-binary.ts`: SOH/STX/EOT blocks + additive checksum,
      `FA` proposals, `FS !offset` resume) and wired into the FBB session — compression is offered via
      `BBS_FORWARD_COMPRESS` and engages only when the partner's SID also advertises `B` (else it negotiates
      back to ASCII). FBB MD5 link auth (`fbb-auth.ts`) is built and tested. Byte-level round-trips,
      negotiation, and resume are unit-tested. Wire facts pinned in
      [`tools/interop/LZHUF-SPEC.md`](tools/interop/LZHUF-SPEC.md).
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
- [x] **KISS-TCP + AGW client** _(P1 · S)_ — attach Direwolf/QtSoundModem/other hubs as modems: the ingest box's
      `kiss.ts` and `agwpe.ts` (`KISS_TNC_HOST`, `AGWPE_HOST`).
- [ ] **Supervised Direwolf** _(P1 · M)_ — the hub launches and manages a Direwolf instance
      (config generation, ALSA/pulse device pick, restart-on-crash) for soundcard AFSK/IL2P.
- [ ] **WA8DED hostmode TNC driver on serial** _(P2 · S)_ — TNC3/SCS-class firmware TNCs in hostmode on a
      serial port; the host-mode driver over TCP is `apps/ingest/src/hostmode.ts` (`HOSTMODE_HOST`).
- [ ] **SCS PACTOR hostmode** _(P2 · L)_ — PTC-II/P4dragon hostmode incl. PACTOR level
      negotiation; unlocks Winlink-grade HF forwarding through the same BBS/forward stack.

**Rig control, keying, position:**

- [ ] **rigctld client** _(P1 · S)_ — talk to an existing hamlib rigctld (net) for
      frequency/mode/PTT; band-tag everything the hub ingests. The client is `packages/aprs/src/rigctld.ts`;
      the hub driver is what's left.
- [ ] **Direct CAT serial drivers** _(P2 · M)_ — Icom CI-V, Kenwood, Yaesu protocol families for
      zero-dependency setups — the codec is `packages/aprs/src/cat.ts`; the hub driver is what's left.
- [ ] **rigctld-compatible re-export server** _(P2 · M)_ — the hub serves the rigctld wire
      protocol so logging/digimode apps share the rig through us — same bridge idea as packet.
- [ ] **PTT/keying paths** _(P2 · M)_ — CAT PTT, CM108 GPIO, Raspberry Pi GPIO beside the serial RTS/DTR
      keying the box has (`apps/ingest/src/ptt.ts`); one PTT abstraction with per-port assignment and
      TX-watchdog. This keys the hub's own transmit ports, gated on callsign control-verification; the Shack's
      rig control through the box below never keys.
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

- [x] **Pocket: a station on an Android phone** — the gateway and the ingest in Termux, without root:
      one-command install, supervised processes, https for hotspot visitors, a MeshCom node on the hotspot or a
      router, backup, and a monthly install check in `termux/termux-docker`
      ([`docs/run/install/pocket.md`](docs/run/install/pocket.md)). A field-day and demo station, not a server.
- [x] **Pocket extras** — the setup questions, a status notification, home-screen shortcuts, a battery saver,
      field alerts, a scheduled backup, a USB KISS TNC through `termux-usb`, 44Net status and https on the ampr.org
      name, a pre-trip sync with a region filter, and the home-instance hub
      ([`docs/run/install/pocket.md`](docs/run/install/pocket.md)). Phone tests of each are recorded in its "Tested on" table.
- [x] **Per-host 44Net records** — `_aprscaching.<host>` records so one callsign publishes several instances
      (a home station and a Pocket), added by host; an ambiguous name lists its candidates. The ARDC-verified
      callsign is recorded on 44net peers and counts as the operator, so the corroboration quorum hears one voice
      per callsign ([`docs/run/networks/44net-identity.md`](docs/run/networks/44net-identity.md#3-name-and-identity)).
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
      keeps its first tier on instances that already mirrored it: the finds feed pages by log id and carries each
      log once. Re-serving a changed find needs a revision on the finds feed, like the caches feed's
      (updated-at cursor, versioned records).
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
compile against; `entryHash` lands before anyone lists, because it changes what a signature covers;
the dashboard surface lands before built-ins can declare it.

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
      live cache spots, award progress. Two existing built-ins join for the cost of a manifest line by
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

Imported-tool API gaps an outside author meets (each is described as it stands in
[`docs/contribute/tool-reference.md`](docs/contribute/tool-reference.md)):

- [ ] **Imported tools vanish when the Tools app closes** _(P2 · S)_ — the list of imported tools is
      `ToolsPanel` state, so leaving the app drops their commands and decoders from the console while
      their frames, panels and bus subscriptions keep running; a re-import then collides with the
      registered name. Keep imported tools in the shared host, give them an on/off switch and a remove
      action, and remember them across reloads.
- [ ] **Imported tools reach events, map layers and transmit** _(P2 · M)_ — the sandbox bridges commands,
      colour rules, panels, decoders and the bus, but not `on()` events, `setMapLayer()`, `scheduleBeacon()`
      or `requestTx()`, so `event`, `map`, `beacon` and `tx` grant an imported tool nothing; `geo` has no API
      at all. Imported commands and decoders answer only in the Tools console, not on the terminal, BBS or
      node, and ignore the console's "as a remote peer" switch.
- [ ] **Async command and decoder handlers** _(P3 · S)_ — a handler that returns a `Promise` prints
      `[object Promise]`; await it in the worker bootstrap so a tool that fetches can answer a command.

Marketplace track (a separate repo on its own timeline; only the first two items touch a shipped
build, and neither gates the release):

- [ ] **`entryHash` content pinning (prerequisite)** _(P1 · S)_ — a manifest signature covers the
      manifest fields including the `entry` URL, but not the script bytes that URL serves, so whoever
      controls the hosting can swap the payload while the signature still verifies. Add `entryHash`
      (SHA-256 of the script) to `ToolManifest` _inside_ the signed bytes; the sandbox hashes what it
      fetched and refuses to evaluate on mismatch; `tools/toolkey` computes it on sign; bucket CI fetches
      and verifies it independently. A new signed field changes `manifestSigningBytes`, so the shipped
      `hello` tool and `apps/web/public/tools/registry.json` are re-signed in the same change. Must land
      before anyone lists — a required signed field cannot be retrofitted afterwards. Side effect worth
      having: a script change forces a version bump and a re-signed manifest. Until it lands, **Tools**
      shows a registry tool as "Signed · registry-listed author key" and with no "verified" badge; with it,
      the badge can come back.
- [ ] **Multi-pin registry authority** _(P1 · S)_ — `verifyRegistry` accepts a small allowlist of
      authority keys instead of a single pinned one, so a rotation ships the new key alongside the old and
      older builds keep verifying through the overlap window. Keep the list at three or fewer and cover
      the forged-authority rejection path — the whole registry trust model rests on this function.
- [ ] **Tool bucket repo + signed publish** _(P1 · M)_ — a public `aprscaching-tools` repo, one JSON
      file per tool under `bucket/`, so a pull request is single-purpose and pubkey continuity is a
      one-file diff. Validation reuses `@aprscaching/tools` (MIT and dependency-free precisely so it can):
      schema, live manifest fetch, a `valid` signature required for listing, independent `entryHash`
      verification, HTTPS-only immutable `entry`, no pubkey change for an existing name outside a
      maintainer-approved rotation, and an automatic review label for the gated capabilities (`network`,
      `tx`, `beacon`, `geo`). Listed tools ship a readable, non-minified entry script so review audits the
      exact bytes the hash then freezes — human review is the enforcement, CI only flags obvious
      minification. Merge builds and signs `registry.json` from the bucket and deploys it to GitHub Pages from a
      reviewer-protected environment; an offline root key designates the online CI signing key, and its
      custody and rotation ship documented with the repo. Listings state a license. Decide the custom
      domain before shipping: `VITE_TOOL_REGISTRY` points at that URL permanently.
- [ ] **Built-in extraction to the bucket** _(P2 · S/M)_ — dogfood the marketplace and produce the
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
- [ ] **Community buckets (multi-registry)** _(M)_ — user-added registry URLs, each with its own
      pinned or trust-on-first-use authority key, bucket name shown in the trust label. First-party
      entries stay `verified`. Keeps the main bucket's review bar high without gatekeeping the ecosystem.
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
      is read-only (`docs/play/find-a-cache.md`, *Caches from other instances*), so a player needs an account on
      every instance whose caches they hunt. The player logs the mirrored cache at home; the find, signed on the
      device as every find is, travels to the cache's home instance with the player's published key and the home
      instance's statement of callsign verification. The cache's instance accepts it only from a trusted peer,
      checks the signature against the key feed, applies its own find rules and grades it from its own evidence
      (Tier A only from its own attested receivers; the home instance's verification counts as far as the peer
      tier allows). It shows as a visitor's find, falls under the cache instance's moderation, and federates back
      like any find. Open: how visitors rank on each instance's leaderboard, rate limits per peer, and the app
      flow (Log on a mirrored cache, delivery state while the peer is unreachable).
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

- [ ] **Log a mirrored cache here, delivered to its home** _(P2 · L)_ — a cache mirrored from a peer is read-only:
      finds point at a local `caches` row, and only the home instance holds the rules that score a find (its
      minimum tier, its receiving stations, stage coordinates and NFC unlocks) and keeps the one
      logbook (one find per callsign, the finds feed peers mirror). A find logged on a
      mirror would travel home as a signed federation frame: the authorship signature the app already makes per
      find, the device reading as evidence, and the logger's callsign key. The home scores it under its own rules
      and publishes it like any find, and the mirror shows it from the finds feed. Needs: a frame kind and its
      `admitFrame()` rules, the home's acceptance of a peer's account by the federated callsign key (a find from
      an unvetted peer quarantined), a queue on the sending instance while the home is unreachable, and the
      mirror's sheet saying the find is on its way. Transport never lifts trust: the tier is the home's.

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
- [ ] **Load the map's data when the base style hangs** _(P3 · S)_ — the first cache fetch runs on MapLibre's
      `load` event (`apps/web/src/platform/useMapInstance.ts`), which fires only once the base style has loaded.
      A style request that fails switches to the grid style (on the style's `error`); one that hangs instead
      leaves the map waiting, and the fallback never triggers. Natural shape: a short timeout after the map is
      created that switches to the fallback style.

- [ ] **Station packs for offline use** _(P3 · M)_ — an offline pack also carries the digipeaters, IGates, MeshCom
  nodes and BBS contacts of its square, for EmComm exercises and for knowing where to beacon with no data. Builds
  on the locator packs (`GET /api/offline/pack`) and the station read APIs.
- [ ] **Offline cache drafts** _(P3 · M)_ — hide a cache on site with no connection: a draft with measured
  coordinates, photos (scaled and thumbnailed in the browser, as uploads are) and text, kept in IndexedDB and
  submitted for publishing when back online, with its media uploaded then. The submit is a hide like any other:
  a verified callsign and the account's daily hide limit apply at that moment.

## Legal & attribution

- [x] **Satellite-layer license** — the shipped satellite layer is EOxCloudless **2016** from EOX's hosted
      tiles, free for non-commercial use under CC BY-NC-SA 4.0, with EOX's own year-matched attribution; a
      commercial instance needs EOX's paid licence or another provider, an instance override via
      `VITE_SAT_TILES` + `VITE_SAT_ATTRIBUTION`. EOX publishes no separate terms for the hosted tiles; ask EOX
      if an instance's use grows past occasional viewing.
- [x] **Production vector basemap** — the default vector style is OpenFreeMap `liberty` (keyless,
      no usage caps, OSM attribution from the style); `VITE_BASEMAP_STYLE` points an instance at any
      MapLibre style URL and `VITE_BASEMAP=offline` keeps the self-contained graticule.
- [x] **Bundle font licenses + user-visible credits** — the OFL-1.1 texts ship under
      `/fonts/` alongside Fredoka/IBM Plex Mono; the CP437 webfont credit (The Ultimate Oldschool PC
      Font Pack, VileR, CC BY-SA 4.0) and the OpenTopoMap/EOX attributions render in
      Settings → Help & credits.
- [x] **Third-party notices surface** — `/third-party-notices.txt` reproduces the copyright notices and
      license texts of every library compiled into the bundle (react, maplibre-gl, uplot, zod, pmtiles, fflate,
      node-forge, …; `@mapbox/jsonlint-lines-primitives` takes the upstream jsonlint notice), linked
      from Help & credits; `apps/web/vite-notices.ts` fails the build when a bundled package has no entry.
      Minified bundles strip headers, so the notices file is the durable surface.
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

- [x] **Platform overlay state** — the map platform's "single-overlay" invariant (at most one top-level
      surface open) is modelled as one `View` value (`apps/web/src/nav.ts`), so opening one surface cannot leave another
      stuck open.

- [x] **Type-aware ESLint** — a separate, slower `lint:types` job runs `@typescript-eslint`
      type-checked rules over `workers/` + `packages/` (the trust-critical surface), gating the real
      promise/assertion bug-catchers while the by-design `any` boundaries stay off. See `eslint.config.types.mjs`.
- [x] **Burn down the lint warnings** — the fast `pnpm lint` is at **0 warnings**; keep it there (clear
      opportunistically when touching neighbouring code, never let the count grow).
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
      Untrusted request-body fields are coerced through `asStr()` (gateway `app.ts`) / a local equivalent
      (`packages/tools`) at every boundary, so a malformed body can never stringify to `[object Object]`.
      **Left:** `no-unnecessary-type-assertion` stays a **warning** — it false-positives on generic
      `.json()`/`unknown` returns under `projectService` (auto-fixing it would strip load-bearing casts).
- [ ] **A preinstalled Raspberry Pi image** _(P3 · L)_ — a ready-to-flash image with the Self-host stack
      and the deploy helpers, so a Pi needs no setup beyond `deploy/aprscaching init selfhost`. It is a large
      build and maintenance effort (image builds per release, updates of the base system), so it waits until the
      helpers have settled on real installations.
- [ ] **One audit trail for sysop actions** _(P2 · S)_ — a claim or release of a callsign is written to
      `callsign_events`, beside `account_events` (manual verifications) and `cache_adoptions` (hand-overs). Fold
      them into the moderation audit log once it lands, keeping each table's erasure rule (the person's account
      and the sysop's note go, the row stays).
- [ ] **Sign back in after losing a passkey-only account's last call** _(P2 · S)_ — an account whose only
      callsign its licensee took over signs in again with an email link and the call it operates now. A
      passkey-only account has no such path: passkey sign-in starts from a callsign. Discoverable-credential
      sign-in (no callsign typed) would let it in to add a call; until then the sysop helps.
- [ ] **Re-serve moved finds to peers** _(P3 · M)_ — finds that move off a claimed call with their account are
      tombstoned on peers, because the finds feed is append-only by id and never re-serves a row. Peers then lose
      those finds instead of showing them under the account's remaining call. A revision-versioned finds feed,
      like the caches feed, would carry them across.
- [ ] **Move the gateway app out of `workers/`** _(P3 · M)_ — `workers/gateway` (`@aprscaching/gateway`) holds the
      runtime-neutral gateway app the Node and Bun servers share, not a Worker. Rename it to `packages/gateway` or
      `core/gateway` — the directory, the package name, every import, the CI paths, the Dockerfiles and the manual —
      in one change after 1.0, when the churn costs no release. Its database shim names (`d1.ts`, `makeD1`) go with
      it.

## Federation hardening

Each finding and its status is tracked in
[`docs/reviews/federation-validation-2026-09.md`](docs/reviews/federation-validation-2026-09.md); every fix
lands with a regression test that fails without it.

- [x] **Identity binding** — instance ids bound to one live peer row, key pins that move only along
      verified rotations, rotated-away keys that expire on every carrier, a submit path that can't
      impersonate, and a registry pinned to its authority key that fails closed.
- [x] **Corroboration as a signed exchange** — signed questions and answers bound to a nonce and the
      question hash, forwarded IGate exclusions, whitelisted evidence, a quorum of distinct verified
      identities, the local track check on peer-corroborated finds, and a bounded, per-asker answerer.
- [x] **Privacy and data correctness** — finds on local-only caches kept home, a composite
      pagination cursor, per-frame fault isolation, and bulletin mirroring.
- [x] **Replay and robustness** — monotonic record versions and bounded signing times, per-type
      sync pages, a rate-limited notify endpoint, SSRF-guarded capped discovery, squat-proof ACSFED ids,
      body caps on pull pages, and relay spokes isolated by their own keys.
- [x] **Low-severity items and operator guidance** — signed-ingest replay cache, erasure of mirrored
      key bindings and moves, a signed migration proof on account moves, domain prefixes on standalone JSON
      signatures, and a "Running federation safely" guide.
- [ ] **Hide one mirrored cache or find from a peer** _(P2 · M, after 1.0)_ — the sysop's **Remove…** reaches
      this instance's own records and bulletins mirrored from peers, but not a single cache or find mirrored from
      a peer: today the sysop asks the peer's operator or blocks the whole peer under **Federation**. Add a
      local suppression keyed to the record's global id (the way a removed mirrored bulletin is suppressed), so
      the item leaves the map, search and offline packs here, a later sync skips it, and the audit log records
      it; the peer keeps its copy.
- [x] **Federation safe-mode defaults in `setup.sh` and the one-click stacks** — the wizard writes
      auto-promotion off and a quorum of 2, leaves discovery unset, takes only https non-44Net peers for
      `FED_PEERS`, requires the spoke list on a hub and the pinned key with a registry, and keeps a LAN instance
      unfederated; `deploy/.env.example`, which the OCI stack copies, carries the same posture.
- [x] **Self-host recipe on a 44net/HAMNET address** — [`docs/run/networks/44net.md`](docs/run/networks/44net.md):
      a 44Net Connect address, the exact `ampr.org` records, the host firewall and an inbound test, what
      signatures protect over plain http and what 44Net does not give, and which features work over HAMNET
      without the internet. The `<call>.ampr.org` identity binding is in
      [`docs/run/networks/44net-identity.md`](docs/run/networks/44net-identity.md#peers-by-callsign).
- [x] **Peers added and removed in Instance admin** — a sysop adds a peer by its URL (the look-up shows its
      instance id and key fingerprint, and the peer is added `unvetted`), raises it to `trusted` in a separate
      step that repeats the fingerprint, and removes it with its pinned key. A `FED_PEERS` entry starts
      `unvetted` unless it pins the fingerprint its key then matches (`<url>#<fingerprint>`).
- [ ] **A peer directory** _(P3 · M)_ — a browsable list of instances that want peers, to pick from in Instance
      admin instead of exchanging URLs by hand. _Why:_ the signed registry already binds names to keys, and a
      directory adds discovery, not trust; joining today takes one exchange of URLs and fingerprints between
      two sysops, which a young network can afford.
- [ ] **Registry DNS lookup through `DOH_URL`** _(P3 · S)_ — `FED_REGISTRY_DNS` always asks Cloudflare's
      resolver (`federation.ts` `registryFromDns`), unlike 44net onboarding and `ampr.org` verification,
      which use `DOH_URL`. _Why:_ an instance on HAMNET without the internet cannot locate its registry by DNS;
      `FED_REGISTRY` (a document URL) is the workaround.

## Federation over RF

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
- [x] **CBOR frames are the only signed record encoding** — the CBOR fedwire frame is the only signed record
      encoding: sync consumes `/federation/sync/<type>` exclusively, `/federation/submit` accepts only
      `application/cbor` (415 otherwise), relay feed answers always carry a CBOR page, and the JSON feeds
      serve unsigned browse items. The stableStringify signing base is used only for standalone signed
      documents (registry, key rotation, account operations, find-log device signatures).
- [x] **44net onboarding wizard in the admin surface** — the sysop federation panel adds a peer by
      callsign (DNSSEC-validated bindings admit in one click; otherwise the resolved key is shown for an
      explicit trust-on-first-use pin) and shows this instance's own records (an instance name under the call,
      by default `aprscaching.<call>.ampr.org`, and the `_aprscaching` TXT, or a `web=` TXT without 44Net) to copy
      into the ARDC portal, with a self-check.
- [x] **Connected-mode sync binding** — the `ACSL1` line protocol (HELLO caps negotiation → one CBOR
      sync page per request, `deflateDict1`-compressed when negotiated) rides the existing session
      machinery; `FedSyncApp` mounts as a node service sourcing pages from the local gateway, the pull
      side delivers pages to `POST /federation/frames` into the shared trust-gated pipeline, and the
      session driver runs async commands in order, so I/O-backed apps work. Dialing the RF
      circuit is validate-at-deploy, like FBB forwarding.
- [x] **Store-and-forward carrier over FBB forwarding** — experimental and off unless `FED_BBS` is on, including
      the relay's packet leg. `encodeFedBbsBatch`/`decodeFedBbsBatch` pack signed frames into a text-safe `ACSFED`
      batch with a content-addressed BID for dedup (`packages/shared`); `POST /federation/bbs/enqueue`
      signs local feed records (tombstones first, same producer as the HTTP sync surface) into one such
      batch, which the forwarding pool offers only to partners marked for federation, as personal mail to
      `ACSFED` at the partner's BBS (never routed by the forward rules, never a bulletin); the
      forward-inbound hook takes an arriving `ACSFED` batch only from a marked partner and routes it through
      `applyFedBbsBulletin`, which
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
      (verified live over the AXUDP wire in the interop loop).
- [x] **Shared compression dictionary** — the `deflateDict1` preset dictionary ships in
      `packages/shared` (immutable wire contract, versioned by capability id); the zlib codec around it
      lives at the ingest box (`apps/ingest`), where compact-tier RF links terminate — with a zip-bomb
      bound and an integrity-checked container so corrupt input fails decode instead of yielding wrong
      bytes.

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

- [ ] **CI depth & deployment shapes** (next release) — boot the `deploy/` compose stacks in CI
      (full stack + ingest-only: `docker compose up`, wait for the gateway healthcheck, smoke `/health`
      and the SPA) beyond the runtime conformance (Node / Bun), and exercise the federation
      push-to-hub **rendezvous relay's** corroboration path.
