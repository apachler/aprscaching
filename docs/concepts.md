# Core concepts

This page explains the rules behind aprscaching in detail — for operators deciding how their instance
verifies finds, and for developers integrating with it.

**In plain words:** a find counts as *radio-verified* only when your APRS position was heard on the air near
the cache by a receiving station that isn't yours. A position that only travelled over the internet proves
nothing about where you were, whatever route it took. Everything below makes that rule precise.

## Verification tiers

A find is only as trustworthy as the evidence behind it. Every find carries exactly one tier:

| Tier | Name | Requirement |
|------|------|-------------|
| **A** | RF-corroborated | The station was heard directly on the air by a receiving site the operator attests — the site's own TNC or MeshCom node, delivered by its own ingest box — that the finder does **not** operate, on a plausible track. An APRS-IS copy (`qAR,<site>`) never counts. |
| **B** | App-corroborated | The finder's own device reported a first-party geolocation that matches the cache at log time. |
| **C** | IS-only | A bare APRS-IS beacon reached the instance — recorded, but not independently corroborated. |

A bare internet packet can never reach Tier B by itself: Tier B requires the independent *app* reading, and
Tier A requires independent *RF* evidence. Each instance sets a **minimum accepted tier** (site default
**B**), and a cache owner may raise it per cache with `min_trust`.

### Corroboration and quorum

When a find can't reach Tier A locally, the instance can ask its federation peers: *"did you independently
hear this callsign on RF near here, at a receiving site that isn't ours?"* A configurable **quorum** of
*distinct* instances must agree before the find is promoted. Each peer answers only from positions it would
attest itself — heard directly by one of its own attested sites, never an APRS-IS copy — so a peer vouches no
more widely than its own Tier A reaches. A peer that denies a corroboration another peer confirmed feeds a
**contradiction signal** that lowers its reputation and blocks auto-promotion. Requests and responses are
coarsened (grid-snapped, time-bucketed, distance-bucketed) so corroboration is never a
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

`firstPartyAttested` is the *only* gate on Tier A. It is set only for a frame that the operator's own
ingest box heard on its own receiver — a local TNC (KISS, AGWPE, WA8DED host mode) or a MeshCom node —
directly, at a receiving site the operator lists as their own (`FIRST_PARTY_SITES`). The ingest box's writes
need the ingest secret, so the path itself vouches for the hearing.

An APRS-IS line is never attested, even one whose q-construct names an attested site (`qAR,OE8XBM-10`):
APRS-IS passcodes are public, so anyone can inject that line. A standalone IGate that is visible only on
APRS-IS therefore counts for nothing here — for its hearings to reach Tier A, run the ingest box
(`apps/ingest`) on that IGate's receiver so it delivers its frames to the gateway itself (see
[RF ingest](operate/rf-ingest.md#receiving-site-and-tier-a)).

The verify engine never branches on the transport, so adding a new transport can raise data *volume* but
never *trust*. Each stored position records its transport (a local TNC, the browser RF bridge, APRS-IS,
AXUDP/AXIP, MeshCom, Meshtastic) for display and statistics, and only the two on-air transports can carry
attestation. APRS-IS, an internet tunnel (AXUDP, AXIP), a licence-free carrier (Meshtastic) and the browser
RF bridge are never attested, whatever site they name — a browser batch is signed by the sender's own device
key and carries only the sender's own frames, so it proves who sent it, not that an independent site heard
it. A test proves no other transport value grants attestation or changes a find's tier.

## Identity

- **Accounts** are anchored to a person, authenticated by a **passkey** (WebAuthn) or an email magic link. One
  account may hold several base callsigns.
- **Finds are signed on-device.** Each user holds an Ed25519 keypair in their browser and registers the public
  key to their callsign, so authorship is cryptographically attributable and stays attributable even after a
  user moves instances. A browser without Ed25519 simply logs unsigned.
- **Callsign control-verification** — proving you operate a callsign — is done by transmitting, or by a
  credential from a body that reviewed the licence. On the air, the holder sends `VERIFY <code>` to the
  instance's service call, and the call is verified only when an attested receiving site hears it on its own
  radio — a TNC, or a MeshCom node that heard it directly over LoRa. A copy over APRS-IS, an internet
  tunnel, the MeshCom server, a mesh relay or the browser radio bridge never counts. Off the air, the holder
  publishes a code under their ARDC-delegated `<call>.ampr.org` name (counted only with a DNSSEC-validated
  answer), or signs a challenge with their ARRL LoTW callsign certificate, whose private key stays in the
  browser. The instance operator confirms their own call with the operator CLI, and a sysop may verify a
  call by hand, with a note, for someone out of range. Every verification records its method and who
  vouched. The APRS-IS passcode verifies nothing (it is a public hash); **licensing plus
  control-verification** is the real gate for anything that keys a transmitter. Control-verification is
  about the person and the callsign; it is separate from the A/B/C tiers, which grade a single find.
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
