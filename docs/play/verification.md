# How finds are verified

Every find gets a badge: **Radio-verified** (A) when your APRS position was heard **on the air** near the
cache by a receiving station the instance runs and that isn't yours, **Location-verified** (B) when your
phone's location matched the cache, or **Logged** (C) when nothing independent placed you there. A position
that only travelled over the internet ([APRS-IS](../glossary.md#aprs-is)) proves nothing about where you were,
so it can never count as more than tier C. [Log a find](log-a-find.md) shows each badge. Most finds are tier B; tier A appears wherever operators run their own receivers and
vouch for them. The full rules are in [The trust model](../reference/trust-model.md).

## Trust follows the radio, not the transport

The single idea that shapes the whole platform: **a packet arriving over the internet proves nothing on its
own.** aprscaching only *believes* a find when independent evidence corroborates it, and that evidence has to
come from the air or from a first-party device reading — never merely from the wire a packet travelled on.
Every find earns one of three honest tiers: **Radio-verified** (A) when a receiving station that isn't yours
heard you on the air near the cache, **Location-verified** (B) when your own device's location matched it,
and **Logged** (C) when nothing independent placed you there — never more than that for a position that only
reached the instance over [APRS-IS](../glossary.md#aprs-is). The badges are explained for players in
[Log a find](log-a-find.md) and as precise rules in [Verification tiers](../reference/trust-model.md#verification-tiers).

## Next

- [Log a find](log-a-find.md).
- [The trust model](../reference/trust-model.md): the precise rules.
