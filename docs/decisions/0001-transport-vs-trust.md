# ADR 0001 — Transport convenience is not trust uplift

**Status:** ACCEPTED (2026-06-29)
**Context doc:** `docs/22-rf-over-internet-transports.md`
**Scope:** the verification engine (`workers/gateway/src/verify.ts`), the provenance
derivation (`workers/gateway/src/provenance.ts`), the normalized packet contract
(`packages/shared/src/packet.ts`), and every present/future ingest transport.

## Decision

A packet's **transport** (the wire it arrived on) MUST NEVER influence its **trust tier**.
The verification engine branches on a single provenance signal — `firstPartyAttested` — and
on nothing else about how the packet reached us.

- **Tier A (RF-corroborated)** is reachable **only** when `firstPartyAttested === true`: the
  fix was heard at a receiving site **we operate and can attest for**. This is independent of
  the transport label (`aprs-is`, `axudp`, `axip`, `hamnet-kiss`, …). Transport never appears
  in a trust branch.
- **Tier B (app-corroborated)** is the first-party in-app device-geolocation path. Global
  verification workhorse at launch.
- **Tier C (IS-only / unattested)** is the honest default for everything else — a bare APRS-IS
  beacon, an injected `qAC`/`qAX` frame, or any internet-tunnelled AX.25 frame. Logged, badged
  unverified.

The independence guard (a fix may not be corroborated by the logger's **own** IGate) stays in
force on top of attestation.

## Why

An internet-sourced packet carries no inherent proof it ever touched RF — regardless of whether
the internet transport is APRS-IS, an AXIP/AXUDP tunnel, or a HAMNET bridge. Letting any
transport imply RF presence would "launder" a packet into a higher tier. Only infrastructure we
control and attest for yields genuine corroboration.

## Consequences

- The `Transport` enum and `Provenance` object (`{ transport, qConstruct?, firstPartyAttested,
  siteId?, heardAt? }`) live in `packages/shared`; only `aprs-is`/`app` are wired today, the rest
  are reserved.
- `provenance.ts` is the single place that derives `firstPartyAttested`. Default rule: an RF fix
  with an RF-originated q-construct (`qAR`/`qAO`) and an independent gating site is attested. An
  operator MAY pin an explicit allowlist via `FIRST_PARTY_SITES`, narrowing attestation to sites
  they own — the honest posture for the deferred owned-RF / HAMNET track.
- Tier A is **designed-for, deferred**: with no owned RF site attested, an instance can run
  Tier B + honest Tier C only, and the engine still supports Tier A the moment a site is attested.
- New transports (AXUDP listener stub in `apps/ingest`, future AXIP/HAMNET-KISS) plug in by
  forwarding frames that derive `firstPartyAttested = false` — they cannot reach Tier A without a
  separate, explicit attestation.
- Reachability over amateur space (44net/HAMNET, reserved `amateurEndpoint` on the registry entry)
  is addressing only — trust-neutral, never a tier uplift.

This rule survives future sessions: do not add a transport check to a trust branch.
