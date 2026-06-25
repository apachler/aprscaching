# APRS-IS identity, addressing & passcodes

Status: **Backlog spec.** How the platform, its federated peers, and its users authenticate to and are
addressed on APRS-IS / APRS RF — for announcements, message delivery, acks, find-logs-over-RF, and
(future) user-originated TX. Grounded in the current code (`apps/ingest/src/aprsis.ts` + `igate.ts`
log in with `user CALL pass PASSCODE`; the outbox stamps `src_call=APRSCG`, `tocall=APZACG`;
`BBS_CALL` defaults to `APRSCG`). Build against the cost rules and `docs/16` (gated TX) + `docs/15`
(federation registry).

## Reality check: the APRS-IS passcode verifies nothing
The APRS-IS passcode is a **public, deterministic hash of the base callsign** — computable for *any*
callsign-formatted string. APRS-IS servers **do not validate licensing**; a login with an invented
(but well-formed) call + its computed passcode is accepted as a **verified** TX connection. So:
- An invented uniform service call is **technically possible** — the network does not block it.
- It is the **wrong choice** anyway, for reasons that are *not* technical:
  1. **RF legality (decisive):** the instant a packet is gated to **RF**, it is an amateur
     transmission and MUST originate from a real licensed call. A fake call on RF is illegal.
  2. **Etiquette/filtering:** fake/abusive calls get blacklisted on APRS-IS.
  3. **Our trust ethos:** we are the verification platform — fake calls on the ham network are
     self-contradictory.
- **Proper auth path:** APRS-IS now supports **TLS login with LoTW certificates** (`aprsc` +
  APRSdroid; experimental on `aprs2.net`) — passwordless and *actually* proves licensing. Design
  toward LoTW-TLS for peers (and eventually direct-TX users); keep the legacy passcode as a fallback.
- **RX-only** connections log in with passcode `-1` (no TX, never gated to RF).

> Invariant: the passcode (or LoTW cert) authorizes a *connection*; it is NEVER our authorization to
> act as a callsign. Acting/TXing as a call is gated by **our control-verification** (the APRS
> message-challenge) — see `docs/10` — never by the passcode.

## The three TX identities
| Who TXes | APRS-IS login | Source call on the wire | Credential | Gate |
|---|---|---|---|---|
| **Peer/platform** (announce, ack, deliver) | the peer's licensed `CALL-<SERVICE_SSID>` | `CALL-<SERVICE_SSID>` (the addressable service id) | peer's LoTW-TLS *or* passcode (`-1` if RX-only) | operator is licensed/responsible |
| **User, via peer** (gated relay) | the **peer's** login | the **user's** call (third-party / `qAR`) | none from the user | our control-verification |
| **User, direct** (browser/RF, `docs/16`) | the **user's** call | the user's call | auto-computed passcode *or* LoTW-TLS | verification + explicit opt-in (H5) |

## Peer service identity (directly addressable, uniform structure)
**Scheme: `<licensedCall>-<SERVICE_SSID>` + a shared `TOCALL` + a federation-registry binding.**
- **Base call** = a real licensed call the peer operator holds (the `aprscaching.net` reference peer
  may use a dedicated club/project call; community peers use their own). Required for RF legality and
  responsibility; uniqueness is automatic (licenses are globally unique). RX-only peers use `-1`.
- **`SERVICE_SSID`** = **network-fixed** (decide once; same on every peer) — the uniform "pattern".
  Recommend **`-10`** (its conventional meaning is *internet gateway*, exactly a peer's role); caveat:
  if an operator also runs a standalone IGate on `-10`, the network picks another reserved value.
- **`TOCALL`** = one shared software id stamped on every packet (allocation below).
- **Directly addressable** = the peer *is* `CALL-10`: users send APRS **messages to** it, it **acks
  from** it, and the **federation instance registry** (`docs/15` T4.2) binds `instance ↔ {url, key,
  aprsCall}` so any peer / the platform can resolve "peer X's APRS service call" and address it. That
  binding (signed, in the registry + advertised at `/.well-known/aprscaching`) is what makes a peer
  addressable *as a network node*.

So peers are **identical in structure** (`CALL-10`, shared tocall, same message/BID/ack format),
differ only by the operator's licensed base call, and are each resolvable through the registry.

## TOCALL allocation
- **`APZ…` is the experimental / self-assigned range — no process.** Pick any unallocated `APZ???`
  and use it; we already use **`APZACG`** (verify the suffix isn't one of the few historically-pinned
  `APZ` codes). Ship with this now.
- **Permanent registered tocall** (e.g. `APAC…`): open an issue/PR on **`github.com/aprsorg/aprs-deviceid`**
  (the successor to `aprs.org/aprs11/tocalls.txt`). Its `ALLOCATING.md` explicitly allocates ids to
  "APRS service implementations which transmit APRS packets on behalf of APRS users" — APRScaching
  **qualifies**. Register one network-wide id and make it the config default for all peers.

## User TX — two paths (users never enter a passcode)
**A — Gated through the peer (the IGate pattern; no user passcode).** The peer injects the user's
beacon/message/find into APRS-IS as **third-party traffic** (`}USERCALL>…`, gated by the *peer's*
login) or keys it to RF via its TX-IGate/digi. Source on the wire = the **user's** call; the peer is
the gate. **Must require our control-verification** so we never put traffic under a call the user
doesn't hold. Extends the existing `igate.ts`.

**B — Direct user→APRS-IS / user→RF (browser-direct, `docs/16` H5).** The user's own client logs in as
themselves (auto-computed passcode — deterministic from the base call, covers all their SSIDs — or
LoTW-TLS) or keys their own radio/TNC. Gated by **verification + explicit opt-in**; TX off by default.

Passcode policy: **no passcode in the normal flow** (path A needs none; path B auto-computes it). The
passcode is never authorization; one passcode covers all of a base call's SSIDs (aligns with
`account_callsigns`, `docs/10`).

## Config contract (per peer)
`APRSIS_CALL` (licensed base call) · `APRSIS_AUTH` = LoTW-TLS cert *or* `APRSIS_PASSCODE` (`-1` for
RX-only) · `SERVICE_SSID` (network-fixed) · `TOCALL` (network-fixed). Federation: the instance
descriptor/registry gains **`aprsCall`** (= `APRSIS_CALL-SERVICE_SSID`). Every peer identical except
the operator call.

## Schema / code touches (small; mostly additive)
- **`aprsPasscode(call)`** — a pure util in `packages/aprs` (the public hash; used for path B + ops
  convenience), unit-tested. Pure → runs in Worker/Node/browser.
- **Third-party injection helper** — extend `igate.ts` to gate a verified user's packet (path A).
- **Outbox / `BBS_CALL` default** — switch from the tactical `APRSCG` to `<APRSIS_CALL>-<SERVICE_SSID>`
  (keep `APRSCG` only as a last-resort fallback); add `SERVICE_SSID`/`TOCALL` to `env.ts`.
- **Federation descriptor** — add `aprsCall` to `handleWellKnown` output; optional `aprs_call` column
  on `fed_peers` lands with the `docs/15` registry work (no migration needed before then).
- **LoTW-TLS APRS-IS login** — a TLS connect + cert auth option in `aprsis.ts`/`igate.ts` (later).

## Rules / trust / legal
- **Transport ≠ authorization.** Neither passcode nor LoTW-cert lets the platform act as a user; only
  our control-verification does. RF reception still earns trust only via `verify.ts`.
- **RF legality:** anything gated to RF originates from a real licensed call (peer's, or a verified
  user's via path A/B). Never gate an invented or unverified call to RF.
- **Cost:** announcements/acks are periodic and batched via the existing outbox; no new always-on
  connection beyond the one APRS-IS login a peer already holds.

## Milestones
- **P1 — peer identity:** `SERVICE_SSID` + `TOCALL` config; outbox/`BBS_CALL` default → `CALL-SSID`;
  `aprsCall` in the well-known descriptor.
- **P2 — tocall registration:** request an `APAC…` id via `aprs-deviceid`; flip the default.
- **P3 — gated user TX (path A):** third-party injection of a control-verified user's traffic.
- **P4 — LoTW-TLS auth:** TLS + LoTW cert login for peers (then direct-TX users).
- **P5 — direct user TX (path B):** with `docs/16` H5 (auto-passcode/LoTW, verified, opt-in).
- Registry `aprsCall` binding lands with `docs/15` T4.2.

## Acceptance (abbreviated)
- A peer announces/acks from `CALL-<SERVICE_SSID>`; users can message that addressee and get an ack
  from it; the federation descriptor advertises the peer's `aprsCall`.
- A user's gated find/beacon appears on APRS-IS with the **user's** call as source, gated by the peer,
  only when the callsign is control-verified.
- No user is ever asked for an APRS-IS passcode; direct TX (path B) stays off until verified + opted in.
- Nothing invented or unverified is ever gated to RF.
