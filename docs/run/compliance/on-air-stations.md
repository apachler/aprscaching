# Automatic stations on the air

This page is for the sysop of an instance that transmits: an IGate, a digipeater, a node or a BBS. Such an
instance is an amateur station, and you are its control operator; this page covers what applies to automatic
stations and what APRScaching does to keep them within the rules.

The rules every operator follows, attended or not, are under
[On-air etiquette and rules](../../shack/on-air.md). This page is not legal advice: meeting the rules at your
station, on your bands, under your licence, is your responsibility as control operator.

## Automatic & unattended operation

A digipeater, an IGate, a NET/ROM node (whichever command style it presents: NET/ROM, FlexNet, TNN or BayCom), a
BBS, a store-and-forward mail path and any automatic federation-over-RF relay are **automatically controlled
stations**. National rules restrict where and how these run: permitted band segments, power, occupied bandwidth,
and a control operator who can be reached. APRScaching's part:

- Automatic transmit (digipeat, beacon, forward, relay) is **opt-in per port**, never implicit.
- Every RF transmit port of the ingest box (a KISS TNC, a [soundcard port](../radios/soundcard.md)) transmits
  only under calls the gateway confirms for that box: control-verified, and held by the box's operator.
- A port that keys the radio itself, the soundcard port, caps its airtime (`SOUNDCARD_DUTY_PCT`, 20 % of any
  minute by default), and a watchdog releases its PTT after `SOUNDCARD_PTT_MAX_MS` (10 s by default). Keep the
  radio's own transmit time-out on as well: it is the only release when the box is killed outright.
- Every unattended transmit path is **paced by a token bucket** with a hard ceiling
  ([Transmit pacing](#transmit-pacing)).
- The digipeater drops a duplicate frame for 30 s, and `DIGI_VISCOUS_MS` holds a repeat back so a better-placed
  digipeater goes first. There is no airtime duty-cycle setting.
- The federation-over-RF carriers choose only the record encoding and batch size for a link, never a band,
  segment or power level ([Federation wire format](../../reference/federation-wire.md)).

### Transmit pacing

Each unattended path draws from its own token bucket: `burst` transmits at once, then one more every `refill`
seconds. Separate buckets keep a busy path (IGate traffic) from starving another (an answer to a radio command).
You can tighten any bucket. A looser value is clamped to the ceiling with a warning at startup, so a typo never
turns an unattended station into a channel hog.

| Path | Unit | Settings | Default | Ceiling |
|---|---|---|---|---|
| Remote box (beacons, messages, answers) | frame | `BOX_TX_BURST`, `BOX_TX_REFILL_SEC` | 3, then 1 per 60 s | 10, then 1 per 6 s |
| MeshCom sends | message | `MESHCOM_TX_BURST`, `MESHCOM_TX_REFILL_SEC` | 3, then 1 per 60 s | 10, then 1 per 6 s |
| TX-IGate (APRS-IS to RF) | message | `IGATE_TX_BURST`, `IGATE_TX_REFILL_SEC` | 6, then 1 per 10 s | 10, then 1 per 6 s |
| FBB forwarding | session | `BBS_FORWARD_BURST`, `BBS_FORWARD_REFILL_SEC` | 4, then 1 per 300 s | 10, then 1 per 60 s |

A refused transmit is always logged:

- a refused remote-box command fails with the wait time;
- a refused IGate message is not gated, and the sender's own retry carries it once a token is back;
- a refused FBB session waits for the next scheduler poll.

Forwarding is paced per session, never per frame: throttling frames inside an open AX.25 link would stall it into
retries.

## What the station puts on the air

- **Identification.** Every APRS and AX.25 frame the station sends carries its source callsign. The NET/ROM
  node identifies through its NODES broadcast, every `NETROM_BROADCAST_MS` (default one hour, at least 5 minutes). The
  digipeater and the IGate have no separate identification timer: they transmit only when relaying, under the
  station's callsign. Check that this meets your national identification rule.
- **Third-party traffic.** A message the instance sends for a user puts the licensed user's callsign as the
  on-air source (`}USERCALL>APZACG,…`), with your station as the sender. When you forward other operators' BBS
  mail, or carry federation records that started at their stations, you remain responsible for your country's
  third-party rules and any international agreements.
- **No ciphertext.** An RF binding never carries ciphertext. A field withheld for privacy, such as a cache
  owner's details under its federation scope, is dropped before it reaches the air, never encrypted onto it.
- **No secrets.** The ingest secret, the session key, per-operator peer keys and the push (VAPID) keys
  authenticate on the internet side only. No radio path carries credential material.

## Bandwidth, band plans and high-speed modes

APRScaching runs over whatever modem your TNC provides: typically 1200-baud AFSK or 9600-baud G3RUH on VHF/UHF,
and 300 baud on HF. It also runs over the ingest box's and the browser's own 1200-baud soundcard AFSK, and over IP links (HAMNET
microwave, and AXIP/AXUDP on the internet side). Symbol-rate, occupied-bandwidth and band-segment rules for these
differ widely by country and band. You decide which ports and bands are enabled; the platform adapts its encoding
to the link you turn on, but it does not choose the RF parameters for you.

## 44Net (AMPRNet) and HAMNET

**44Net** is amateur IP address space reachable from the internet, through 44Net Connect or BGP. **HAMNET** is
an amateur IP network reached over RF links, and by licensed hams through HAMNET VPN access. They are separate
networks, and the rules follow the path the traffic takes:

- **HAMNET** traffic crosses amateur RF, so it is amateur radio: no content encryption, and callsign
  identification and control-operator rules apply, as on a 1200-baud packet channel. Where a HAMNET segment has
  a gateway to the internet, the amateur-service boundary sits at that gateway. You are responsible for what
  crosses it in each direction.
- **44Net** traffic between internet hosts, such as two 44Net Connect addresses, travels over the internet, not
  over amateur RF; ARDC's terms for the address still apply. Where it continues onto an RF link of yours, that
  leg is amateur radio, with the same rules.

## What APRScaching enforces, and what stays yours

| APRScaching provides | You own |
|---|---|
| Signs, never encrypts; confidentiality degrades to field-drop | Confirming that satisfies *your* regulator |
| Transmit off by default, gated on control-verification | Being the reachable, responsible control operator |
| Per-port opt-in for automatic TX; token-bucket pacing on unattended TX, with a ceiling | Choosing enabled bands, ports, power and segments; tightening the pacing to any duty-cycle limit your rules set |
| Callsign in every frame; NODES broadcast interval (`NETROM_BROADCAST_MS`, default 3600000 ms) | Meeting your national ID rule |
| Third-party encapsulation preserving the originating callsign | Meeting third-party and international-traffic rules |
| Recognition-only donations; no commercial payloads | Keeping your on-air content non-commercial |

## Next

- [Data protection (GDPR)](data-protection.md): the other half of running a public instance.
- [RF ingest & transports](../radios/rf-ingest.md): turn on the ports this page talks about.
