# Automatic stations on the air

An instance that transmits (an IGate, a digipeater, a node, a BBS) is an amateur station, and its sysop is
the control operator. The rules every operator follows are under
[On-air etiquette and rules](../../shack/on-air.md); this page covers what applies to automatic stations.

## Automatic & unattended operation

A digipeater, IGate, NET/ROM node (whichever command style it presents — NET/ROM, FlexNet, TNN or
BayCom), BBS, store-and-forward mail path, and
any automatic federation-over-RF relay are **automatically-controlled stations**. National rules
restrict where and how these run — permitted band segments, power, occupied bandwidth, and the
requirement that a control operator be reachable. aprscaching's part:

- automatic transmit (digipeat / beacon / forward / relay) is **opt-in per port**, never implicit;
- every unattended transmit path is **paced by a token bucket** with a hard ceiling (see
  [Transmit pacing](#transmit-pacing)); the digipeater suppresses a duplicate frame for 30 s and can hold
  a repeat back (`DIGI_VISCOUS_MS`). There is no airtime duty-cycle setting;
- the federation-over-RF carriers choose only the *record encoding and batch size* for a link
  (`workers/gateway/src/fedtransport.ts`) — never a band, segment, or power level.

### Transmit pacing

Each unattended path draws from its own token bucket: `burst` transmits at once, then one more every
`refill` seconds. Separate buckets keep a busy path (IGate traffic) from starving another (an answer to
a radio command). The operator can tighten any bucket freely; a looser value is clamped to the ceiling
with a warning at startup, so a typo can never turn an unattended station into a channel hog.

| Path | Unit | Settings | Default | Ceiling |
|---|---|---|---|---|
| Remote box (beacons, messages, answers) | frame | `BOX_TX_BURST`, `BOX_TX_REFILL_SEC` | 3, then 1 per 60 s | 10, then 1 per 6 s |
| MeshCom sends | message | `MESHCOM_TX_BURST`, `MESHCOM_TX_REFILL_SEC` | 3, then 1 per 60 s | 10, then 1 per 6 s |
| TX-IGate (APRS-IS → RF) | message | `IGATE_TX_BURST`, `IGATE_TX_REFILL_SEC` | 6, then 1 per 10 s | 10, then 1 per 6 s |
| FBB forwarding | session | `BBS_FORWARD_BURST`, `BBS_FORWARD_REFILL_SEC` | 4, then 1 per 300 s | 10, then 1 per 60 s |

A refused transmit is always logged. A refused remote-box command fails with the wait time; a refused
IGate message is not gated, and the sender's own retry carries it once a token is back; a refused FBB
session is deferred to the next scheduler poll. Forwarding is paced per session, never per frame —
throttling frames inside an open AX.25 link would stall it into retries.

## Bandwidth, band plans, and high-speed modes

aprscaching is **field-first**: it runs over whatever modem your TNC provides — typically 1200-baud AFSK
or 9600-baud G3RUH on VHF/UHF and 300-baud on HF — plus the browser's own 1200-baud soundcard AFSK, and
over IP links (HAMNET microwave, and internet-side AXIP/AXUDP).
Symbol-rate, occupied-bandwidth, and band-segment rules for these differ widely by country and band.
The operator decides which ports and bands are enabled; the platform adapts its encoding to whatever
link you turn on, but it does not choose the RF parameters for you.

## 44net (AMPRNet) and HAMNET

**44net** is amateur IP address space and **HAMNET** is an amateur microwave IP backbone. Traffic on
them is still amateur radio: **no content encryption**, callsign identification, and control-operator
rules all apply, exactly as on a 1200-baud packet channel. Where a HAMNET or 44net segment bridges to
the general internet, the amateur-service boundary sits at that RF/gateway edge — you are responsible
for what crosses it in each direction.

## What aprscaching enforces, and what stays yours

| aprscaching provides | You own |
|---|---|
| Signs, never encrypts; confidentiality degrades to field-drop | Confirming that satisfies *your* regulator |
| Transmit off by default, gated on control-verification | Being the reachable, responsible control operator |
| Per-port opt-in for automatic TX; token-bucket pacing on unattended TX, with a ceiling | Choosing enabled bands, ports, power, and segments; tightening the pacing to any duty-cycle limit your rules set |
| Callsign in every frame; NODES broadcast interval (`NETROM_BROADCAST_MS`) | Meeting your national ID rule |
| Third-party encapsulation preserving the originating callsign | Meeting third-party and international-traffic rules |
| Recognition-only donations; no commercial payloads | Keeping your on-air content non-commercial |

> Again: **not legal advice.** These are the mechanisms aprscaching gives you to operate within the
> rules — meeting them at your station, on your bands, under your licence, is your responsibility as
> control operator.

## Next

- [Data protection (GDPR)](data-protection.md).
