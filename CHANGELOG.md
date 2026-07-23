# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project aims to follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). From 1.0.0 onward, releases and this file
are maintained automatically by [release-please](https://github.com/googleapis/release-please) from
[Conventional Commits](https://www.conventionalcommits.org/).

## [Unreleased]

The feature set awaiting the first public release (1.0.0): an APRS geocaching game wrapped around a
full ham-radio Shack, self-hostable on a Raspberry Pi, running as a Cloudflare Worker,
or as a single Bun desktop binary, and federating with other instances into one open network.

### Added

- **Caching core** — hide/find caches, verified-by-radio finds with the A/B/C trust model
  (RF-corroborated / app-corroborated / IS-only), geofencing, living/virtual/audio/staged caches,
  ratings, media, 10-char Maidenhead, heritage imports (OpenCaching/SOTA/POTA).
- **The Shack** — packet terminal, threaded BBS with FBB forwarding, NET/ROM node + digipeater,
  a signed tool-plugin system, weather stations, telemetry graphs, and a raw-packet view.
- **RF ingest, operator-owned** — `apps/ingest` (KISS-over-TCP, IGate, digipeater) and a browser
  Web Serial / Web Bluetooth / soundcard-AFSK path; APRS-IS + AXUDP/AXIP internet transports.
- **Federation** — signed cache/find/key/tombstone/account-move feeds, peer trust tiers, corroboration
  quorum, a signed instance registry, and push-to-hub for NAT'd peers.
- **Identity** — passkeys (WebAuthn), email magic-link, multiple verified base callsigns per account,
  APRS message-challenge control-verification.
- **Public read API** with free per-IP limits and free keys; GPX/KML/ADIF exports; embeddable map
  widget + QR; live activity spots (POTA/SOTA/GMA, DX/RBN/PSKReporter).
- **Tri-runtime** — one shared handler set across Node+SQLite, Cloudflare Worker+D1, and Bun+bun:sqlite,
  all conformance-green; five deployment topologies.
- **Governance** — AGPL §13 source link (`/.well-known/source`), recognition-only donations,
  GDPR export/erase with federated tombstones.
- **Sysop onboarding** — a "first hour as sysop" walkthrough plus an in-app Setup checklist
  (`GET /api/admin/setup`): env-only settings reported read-only as statuses (secret values are
  never echoed), runtime state probed live, writable config staying with the existing sysop
  surfaces.

### Security

- Full reliability & security hardening pass ahead of going public: every Critical, High, Medium and
  Low finding fixed, each with a regression test — trust-model corroboration legs, federation
  malicious-peer defenses, session/secret boot guards, ingest resilience, packet-stack robustness,
  tri-runtime parity, config validation, web-app lifecycle/device-key handling, and 24/7 runtime hygiene.

[Unreleased]: https://github.com/apachler/aprscaching/commits/HEAD
