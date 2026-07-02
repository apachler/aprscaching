# Core concepts

Read this before deploying or integrating. It explains the model everything else in aprscaching follows.

## Verification tiers

A find is only as trustworthy as the evidence behind it. Every find carries exactly one tier:

| Tier | Name | Requirement |
|------|------|-------------|
| **A** | RF-corroborated | The station was heard on the air (an `qAR` q-construct), gated by an IGate that the finder does **not** operate, on a plausible track. |
| **B** | App-corroborated | The finder's own device reported a first-party geolocation that matches the cache at log time. |
| **C** | IS-only | A bare APRS-IS beacon reached the instance — recorded, but not independently corroborated. |

A bare internet packet can never reach Tier B by itself: Tier B requires the independent *app* reading, and
Tier A requires independent *RF* evidence. Each instance sets a **minimum accepted tier** (site default
**B**), and a cache owner may raise it per cache with `min_trust`.

### Corroboration and quorum

When a find can't reach Tier A locally, the instance can ask its federation peers: *"did you independently
hear this callsign on RF near here, gated by an IGate that isn't ours?"* A configurable **quorum** of
*distinct* instances must agree before the find is promoted. A peer that denies a corroboration another peer
confirmed feeds a **contradiction signal** that lowers its reputation and blocks auto-promotion. Requests and
responses are coarsened (grid-snapped, time-bucketed, distance-bucketed) so corroboration is never a
location oracle.

## Transport is not trust

This is the rule that keeps the tiers honest:

> A packet arriving over the internet carries no proof it ever touched RF — whether the transport is
> APRS-IS, an AXUDP/AXIP tunnel, or a HAMNET link. Only infrastructure *you* operate and can attest for
> yields Tier A.

The verification engine consumes a normalized **provenance** object, never a raw transport:

```
{ transport, qConstruct?, firstPartyAttested, siteId?, heardAt? }
```

`firstPartyAttested` is the *only* gate on Tier A, and it is set solely by a receiving site the operator lists
as their own (`FIRST_PARTY_SITES`). The transport type never appears in trust branching — so adding a new
transport can raise data *volume* but never *trust*.

## Identity

- **Accounts** are anchored to a person, authenticated by a **passkey** (WebAuthn) or an email magic link. One
  account may hold several base callsigns.
- **Finds are signed on-device.** Each user holds an Ed25519 keypair in their browser and registers the public
  key to their callsign, so authorship is cryptographically attributable and stays attributable even after a
  user moves instances. A browser without Ed25519 simply logs unsigned.
- **Callsign control-verification** — proving you operate a callsign — is done with an APRS-message challenge,
  not the APRS-IS passcode. The passcode verifies nothing (it is a public hash); **licensing plus
  control-verification** is the real gate for anything that keys a transmitter.
- **Transmit is gated.** Any on-air TX (announce uplink, IGate TX, browser keying) requires a verified
  callsign and is off by default.

## Federation

Any instance — edge or self-hosted — publishes **read-only, Ed25519-signed feeds** (caches, finds, keys,
bulletins, tombstones). Peers mirror each other into a shared catalog after verifying every record's
signature against the publisher's key. Peers carry **trust tiers** (`trusted` / `unvetted` / `blocked`) and a
reputation; a signed **instance registry** (with a DNS-TXT anchor) binds instance names to keys. Firewalled
peers can still contribute through **push-to-hub** and a poll-based **rendezvous relay**. GDPR deletions
propagate as signed **tombstones**. See [Federation](guides/federation.md).

## Runtimes and locality

- The **gateway** runs identically on three runtimes — Cloudflare Worker + D1, Node + SQLite, or Bun — proven
  by one conformance suite. Choose by where you want to host ([Deployment](operate/deployment.md)).
- The **RF ingest is always operator-local**: a process on your own Pi/PC, or the browser bridging a USB/BLE
  radio. It is never cloud-only, and off-grid operation (ingest + gateway on one box, no internet) is a
  first-class mode.
- Every public instance must expose its own source (a visible link and `/.well-known/source`) to satisfy the
  AGPL's network-use clause.
