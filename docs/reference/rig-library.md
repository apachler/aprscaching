# Rig control library

The rig-control library behind the Shack's Rig control app, for integrators.

## Library: Hamlib `rigctld` client

The **Rig control** app speaks only the Web Serial protocols above; radios it does not cover need a
Hamlib-based program of their own. For integrators, the library ships `RigctldClient` (`@aprscaching/aprs`),
which speaks the `rigctld` TCP text protocol — set/get frequency (`F`/`f`), mode (`M`/`m`), PTT (`T`/`t`), and
`\dump_state` capability negotiation — to a separate `rigctld` process, so Hamlib is never linked and the
library stays MIT-clean. No app or ingest box connects to `rigctld`; a companion that does is planned, tracked
in [`TODO.md`](https://github.com/apachler/aprscaching/blob/dev/TODO.md).

## Next

- [Rig control & weather](../shack/rig-weather.md).
