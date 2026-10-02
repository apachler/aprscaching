# Packet decoder & BBS

The Shack's packet apps: decode any frame, and use the instance's BBS and node.

## Packet decoder

Paste a line in the usual TNC2 format, for example

```
OE8APR-9>APRS,WIDE1-1,qAR,OE8XBM-10:!4703.00N/01526.00E>mobile
```

(`qAR,OE8XBM-10` is the [q-construct](../glossary.md#q-construct): where the packet entered APRS-IS), and
the decoder shows what it contains: position (plain, compressed or Mic-E), course, speed, altitude,
objects and items, messages with acknowledgements, bulletins, status, weather and telemetry.

## BBS, node and forwarding

The instance's BBS forwards mail with the wider packet network (FBB forwarding), and its NET/ROM node links
with other nodes. Setting those up is the operator's job: see [Packet BBS & node](../run/radios/packet-node.md).

## Next

- [Rig control & weather](rig-weather.md).
