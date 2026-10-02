# On-air etiquette and rules

This page is for you as an individual operator who transmits from APRScaching: a beacon, a message, a packet
connect or a weather report. It sets out the amateur rules that apply to every frame you send, and what the
software does to help you keep them.

!!! warning "This is not legal advice"
    Amateur regulations differ by country and change over time. You are the **control operator** of your
    station and solely responsible for its transmissions. Check everything here against your own licence
    conditions and your national authority (US FCC Part 97, CEPT/ECC in Europe, and your national telecom
    regulator).

## You are the control operator

APRScaching is software; the licence is yours. Nothing the platform or its users do relieves you of
responsibility for what leaves your antenna. The software helps in three ways:

- **Transmit is off by default and gated.** The browser radio's beacon and messages, the APRS-IS weather
  beacon and the CWOP relay, the **Packet terminal**'s connections, and plugins that transmit all stay off until
  your callsign is
  **control-verified**: you sent `VERIFY <code>` and a receiving site the instance attests heard it on the
  air, you proved the call another way ([Verify your callsign](../play/join.md#verify-your-callsign)), or a
  sysop vouched for it. The APRS-IS passcode verifies nothing and is never the gate.
- **Every transmission is a choice.** The browser asks you to confirm each beacon and message, and switching
  on **Enable transmit** is a separate step.
- **Receiving never obliges you to transmit.** Receiving is always allowed and never raises trust
  ([The trust model](../reference/trust-model.md)).

## No encryption on the air — sign, never conceal

Amateur rules broadly prohibit messages **encoded to obscure their meaning**. APRScaching is built around that
rule:

- **It signs; it does not encrypt.** Federation records, tombstones, account moves, the signatures on your
  finds and plugin signatures are **digital signatures**: they prove who sent a record and that nobody changed
  it. The content stays in the clear and anyone can read it off the air. Signing for authentication is
  permitted; encrypting for secrecy is not.
- **Privacy means leaving out, never encrypting.** A field the platform withholds for privacy, such as a
  cache owner's details, is **dropped** before it reaches the air, never encrypted onto it.
- **Secrets never touch the air.** The instance's secrets and your device key are internet-side only; no
  radio path carries credential material.

Everything APRScaching puts on the air is public, signed and readable, which is what keeps it legal.

## Station identification

Every APRS and AX.25 frame you send from APRScaching carries your callsign and SSID as its source. Your
regulator may still require an identification at fixed intervals, for example during a long connected
session: check your national rule.

## Third-party traffic

Relaying messages **on behalf of other people** (third-party traffic) is restricted, and international
third-party traffic is permitted only with specific countries. When you send BBS mail to another country, or a
radio command that the instance answers through its own station, you remain responsible for your country's
third-party rules.

## No commercial traffic

The amateur service is non-commercial. Donations to APRScaching are recognition-only and never unlock
features, and caches carry no advertising. Keep anything you put on the air the same way.

## Next

- [Your radio in the browser](my-radio.md): connect and transmit.
- [Automatic stations on the air](../run/compliance/on-air-stations.md): for a sysop's IGate, digipeater or node.
