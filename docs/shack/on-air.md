# On-air etiquette and rules

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
  is **control-verified**: its holder transmitted `VERIFY <code>` and a receiving site you attest heard it
  on the air, or the operator or a sysop vouched for it (see [Instance admin at a glance](../run/day-to-day/index.md)). The
  APRS-IS passcode verifies nothing and is never the gate. See [RF ingest & transports](../run/radios/rf-ingest.md).
- **Receiving never obligates transmitting.** RX is always safe and never lifts trust
  ([The trust model](../reference/trust-model.md)); enabling automatic TX (digipeat, beacon, forward) is a separate,
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
APRS/AX.25 frame aprscaching sends carries its source callsign. The NET/ROM node identifies through its
NODES broadcast, whose interval is `NETROM_BROADCAST_MS` (default 5 minutes). The digipeater and IGate
have no separate identification timer: they transmit only when relaying traffic, under the station's
callsign. Check that this meets your national identification rule.

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

## Next

- [Automatic stations on the air](../run/compliance/on-air-stations.md): for a sysop's IGate, digipeater or node.
