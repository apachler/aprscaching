# The trust model

This page states the exact rules by which APRScaching grades a find and trusts a callsign. It is for sysops
deciding how their instance verifies finds and for integrators building on it; the player's version is
[How finds are verified](../play/verification.md).

**In one sentence:** a find counts as radio-verified only when your APRS position was heard on the air near
the cache by a receiving station that is not yours. A position that only travelled over the internet proves
nothing about where you were, whatever route it took.

## Verification tiers

Every find carries exactly one tier, graded by the evidence behind it:

| Tier | Name | Requirement |
|------|------|-------------|
| **A** | Radio-verified | The station was heard directly on the air by a receiving site the operator attests (the site's own TNC or MeshCom node, delivered by its own ingest box), on a plausible track, and the finder does **not** operate that site. An APRS-IS copy (`qAR,<site>`) never counts. |
| **B** | Location-verified | The finder's own device reported a first-party geolocation that matches the cache at log time. |
| **C** | Logged | Nothing independent placed the finder at the cache: at most a bare APRS-IS beacon reached the instance. Recorded, not verified. |

- A bare internet packet never reaches Tier B on its own: Tier B requires the independent app reading, and
  Tier A requires independent RF evidence.
- A find counts as verified from the instance's minimum up: **Tier B** by default, **Tier A** with
  `MIN_TRUST=A`. A cache's own `min_trust`, set by its hider (**Radio-verified finds only**), takes
  precedence; clearing it returns the cache to the instance's minimum.
- A radio message carries no device reading, so a find logged by radio reaches Tier A or C, never B.
- The app shows the names everywhere a find's trust appears, with the letter as a secondary label.

The tiers grade a single find. A verified *callsign* (control of the licence) is a separate fact about the
account and never wears a tier's name or colour ([Identity](#identity)).

### Corroboration and quorum

When a find cannot reach Tier A locally, the instance can ask its federation peers: *did you independently
hear this callsign on RF near here, at a receiving site that is not ours?*

- A **quorum** of *distinct* instances must agree before the find is promoted; two by default.
- Each peer answers only from positions it would attest itself: heard directly by one of its own attested
  sites, never an APRS-IS copy. A peer vouches no more widely than its own Tier A reaches.
- A peer that denies a corroboration another peer confirmed feeds a **contradiction signal**. It lowers that
  peer's reputation and blocks automatic promotion.
- Questions and answers are coarsened (grid-snapped, time-bucketed, distance-bucketed), so corroboration is
  never a location oracle.

The wire mechanics (signed questions, retries, the logger's own-track check) are under
[Cross-instance corroboration](federation-trust.md#cross-instance-corroboration).

## Transport is not trust

> A packet arriving over the internet carries no proof it ever touched RF, whether the transport is APRS-IS,
> an AXUDP/AXIP tunnel or a HAMNET link. Only infrastructure *you* operate and can attest for yields Tier A.

The verification engine reads a normalised **provenance** object, never a raw transport:

```
{ transport, qConstruct?, firstPartyAttested, siteId?, heardAt? }
```

`firstPartyAttested` is the *only* gate on Tier A. It is set only for a frame that the operator's own ingest
box heard directly on its own receiver, a local TNC (KISS, AGWPE, WA8DED host mode) or a MeshCom node, at a
receiving site the sysop trusts (Instance admin → **Trusted receiving stations**, an enrolled box's
**Trust this station's hearings**, or the configuration preset `FIRST_PARTY_SITES`). A site trusted through an
enrolled box counts only for the frames that box delivers itself, and a box's frames claim no other site:
`FIRST_PARTY_SITES` and the stations added by call count only for frames sent with the shared ingest secret.

- **The site is named on both sides.** The ingest box stamps its frames with `RF_SITE_CALL`, and the gateway
  attests that call.
- **The path vouches for the hearing.** The ingest box's writes need the ingest secret or its enrolled key.
- **Tier A is default-deny.** Until a site is attested, no find reaches Tier A locally and no member can
  verify a callsign on the air, because nothing the instance hears counts as heard by its own radio.

An APRS-IS line is never attested, even one whose q-construct names an attested site (`qAR,OE8XBM-10`):
APRS-IS passcodes are public, so anyone can inject that line. A standalone IGate visible only on APRS-IS
therefore counts for nothing here. For its hearings to reach Tier A, the ingest box (`apps/ingest`) runs on
that IGate's receiver and delivers its frames to the gateway itself
([Receiving site and Tier A](../run/radios/rf-ingest.md#receiving-site-and-tier-a)).

The verify engine never branches on the transport, so a new transport can raise data *volume* but never
*trust*. Each stored position records its transport for display and statistics:

| Transport | Can carry attestation |
|---|---|
| Local TNC (KISS, AGWPE, WA8DED host mode) on the operator's ingest box | yes, at an attested site |
| MeshCom node on the operator's ingest box, heard directly over LoRa | yes, at an attested site |
| APRS-IS | never |
| AXUDP, AXIP and other internet tunnels | never |
| Meshtastic (licence-free carrier) | never |
| The browser RF bridge | never |

A browser batch is signed by the sender's own device key and carries only the sender's own frames: it proves
who sent it, not that an independent site heard it. A test proves that no other transport value grants
attestation or changes a find's tier.

## Identity

- **Accounts** belong to a person, who signs in with a **passkey** (WebAuthn) or an email link. One account
  may hold several base callsigns.
- **Finds are signed on the device.** Each user holds an Ed25519 key pair in the browser and registers the
  public key to their callsign. Authorship stays attributable, even after the user moves instances. A browser
  without Ed25519 logs unsigned.
- **Transmitting is gated.** Any on-air transmission the platform makes for a user (announce uplink, IGate
  transmit, browser keying) requires a verified callsign and is off by default.

### Callsign control-verification

Control-verification proves that you operate a callsign. It is about the person and the call, separate from
the tiers that grade a find. Every verification records its method and who vouched.

| Method | Counts when |
|---|---|
| On the air | The holder sends `VERIFY <code>` to the instance's service call, and an attested receiving site hears it on its own radio: a TNC, or a MeshCom node that heard it directly over LoRa |
| ampr.org DNS | The holder publishes the code under their ARDC-delegated `<call>.ampr.org` name, confirmed by a DNSSEC-validated answer or by several independent public resolvers returning the same record |
| LoTW certificate | The holder signs a challenge with their ARRL LoTW callsign certificate, whose private key stays in the browser |
| Operator CLI | The instance's operator confirms their own call listed in `ADMIN_CALLSIGNS` |
| By hand | A sysop verifies a call, with a note, for someone out of range |

A copy over APRS-IS, an internet tunnel, the MeshCom server, a mesh relay or the browser radio bridge never
verifies a call. The APRS-IS passcode verifies nothing: it is a public hash. Licensing plus
control-verification is the real gate for anything that keys a transmitter.

## Next

- [How federation stays honest](federation-trust.md): how peers sign and corroborate.
- [How finds are verified](../play/verification.md): the same rules for players.
