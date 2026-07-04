# Amateur-radio regulatory compliance

The moment an aprscaching instance keys a transmitter — digipeating, IGating, running a node or BBS,
forwarding store-and-forward mail, or carrying federation over the air — it operates in the **amateur
radio service**, and amateur rules apply to every frame it sends. This chapter maps the constraints
that shape the platform and shows where aprscaching enforces them for you and where responsibility
stays with you.

> **This is not legal advice.** Amateur regulations differ by country and change over time. You are the
> **control operator** of your station and are solely responsible for its transmissions. Verify
> everything here against your own licence conditions and national authority (US FCC Part 97,
> CEPT/ECC in Europe, and your national telecom regulator).

## You are the control operator

aprscaching is software; the licence is yours. Nothing the platform or its users do relieves the
station's control operator of responsibility for what leaves the antenna. Two controls make that
tractable:

- **Transmit is off by default and gated.** Browser and RF transmit are disabled until the callsign
  is **control-verified**; the APRS-IS passcode verifies nothing and is never the gate. See
  [RF ingest & transports](rf-ingest.md).
- **Receiving never obligates transmitting.** RX is always safe and never lifts trust
  ([Core concepts](../concepts.md)); enabling automatic TX (digipeat, beacon, forward) is a separate,
  explicit, per-port opt-in.

## No encryption on the air — sign, never conceal

Amateur rules broadly prohibit transmitting messages **encoded to obscure their meaning**. This is the
single hardest constraint on carrying an application protocol over RF, and aprscaching is built around
it:

- **aprscaching signs; it does not encrypt.** Federation feed pages, signed tombstones, account-move
  records, device-key find signatures, and tool-manifest signatures are all **digital signatures** —
  they authenticate origin and integrity. They do **not** conceal content: the payload stays in the
  clear and is fully readable off the air. Signing for authentication is permitted; encrypting for
  secrecy is not.
- **Confidentiality degrades to omission, never to ciphertext.** Any field the platform withholds for
  privacy — `fed_scope` owner-field redaction, or any non-public payload — is **dropped** before it
  reaches an RF binding, never encrypted onto it. **An RF transport binding MUST NOT carry
  ciphertext.**
- **Secrets never touch the air.** The ingest secret, the session HMAC key, per-operator peer keys,
  and VAPID keys are internet-side authentication only. They are not transmitted, and RF paths carry
  no credential material.

The practical result: everything aprscaching would put on the air is already public, signed, and
inspectable — which is exactly what keeps it legal.

## Station identification

Automatic stations must identify with their callsign at the interval your regulator requires. Every
APRS/AX.25 frame aprscaching sends carries its source callsign, and beacon/identification intervals
for the digipeater, IGate, node, and beacons are operator-configured in `apps/ingest`. Set them to
satisfy your national identification rule.

## Automatic & unattended operation

A digipeater, IGate, NET/ROM (and FlexNet/TheNet/BayCom) node, BBS, store-and-forward mail path, and
any automatic federation-over-RF relay are **automatically-controlled stations**. National rules
restrict where and how these run — permitted band segments, power, occupied bandwidth, and the
requirement that a control operator be reachable. aprscaching's part:

- automatic transmit (digipeat / beacon / forward / relay) is **opt-in per port**, never implicit;
- **duty-cycle and rate limits** are configurable on each transmit port in `apps/ingest`;
- the tiered RF transport negotiator chooses only the *record encoding and batch size* for a link's
  capability — it never selects a band, segment, or power level on your behalf.

## Third-party traffic & message handling

Relaying messages **on behalf of other people** ("third-party traffic") is restricted, and
international third-party handling is permitted only with specific countries. aprscaching's
third-party encapsulation puts the licensed user's callsign as the on-air source
(`}USERCALL>APZACG,…`) while your gateway is the sending station. When you forward others' BBS mail or
carry federation records that originated at other operators' stations, you remain responsible for
meeting your country's third-party rules and any applicable international agreements.

## No commercial or pecuniary traffic

The amateur service is non-commercial. aprscaching's **donations are recognition-only** and never
gate features, so nothing that looks like paid promotion rides the air; cache content and federation
records carry no advertising. Keep it that way on any RF binding.

## Bandwidth, band plans, and high-speed modes

aprscaching is **field-first** — 1200-baud AFSK and 9600-baud G3RUH on VHF/UHF, 300-baud on HF — and
also supports high-bandwidth modes (HAMNET microwave IP, robust HF, and internet-side AXIP/AXUDP).
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
| Per-port opt-in for automatic TX; configurable duty-cycle/rate | Choosing enabled bands, ports, power, and segments |
| Callsign in every frame; configurable ID/beacon intervals | Setting intervals to your national ID rule |
| Third-party encapsulation preserving the originating callsign | Meeting third-party and international-traffic rules |
| Recognition-only donations; no commercial payloads | Keeping your on-air content non-commercial |

> Again: **not legal advice.** These are the mechanisms aprscaching gives you to operate within the
> rules — meeting them at your station, on your bands, under your licence, is your responsibility as
> control operator.
