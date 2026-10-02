# Rig control library

This page lists the rig-control functions in `@aprscaching/aprs` (MIT), for integrators who build their own
rig control. The Shack's **Rig control** app uses the CAT codec; using the app is under
[Rig control & weather](../shack/rig-weather.md).

## CAT codec

The codec builds the bytes for three radio families; the caller owns the serial port (in the app, the browser
over Web Serial).

| Export | What it does |
|---|---|
| `CatRig` | The radio family: `"kenwood"` (Kenwood ASCII `FA…;`, also modern Yaesu such as FT-991 and FTDX), `"icom"` (Icom CI-V binary) or `"yaesu-bin"` (classic Yaesu binary: FT-817, 857, 897) |
| `catSetFrequency(rig, hz, { icomAddr })` | The set-VFO-frequency command. `icomAddr` is the CI-V address, `0x94` by default |
| `catSetMode(rig, mode, { icomAddr })` | The set-mode command, or `null` when the mode is not mapped for that family. Mode setting is best-effort; frequency is the reliable core |
| `APRS_FREQ` | The APRS calling frequencies in Hz: `eu` 144 800 000, `na` 144 390 000 |

## Hamlib `rigctld` client

Radios outside the three families need a Hamlib program of their own. `RigctldClient` speaks the `rigctld` TCP
text protocol to a separate `rigctld` process, so Hamlib is never linked and the library stays MIT-clean. The
client is pure: the caller supplies a transport whose `send(line)` returns the daemon's reply.

| Method | `rigctld` command |
|---|---|
| `setFrequency(hz)` / `getFrequency()` | `F` / `f` |
| `setMode(mode, passbandHz)` / `getMode()` | `M` / `m` (passband `0` is the radio's default) |
| `setPtt(on)` / `getPtt()` | `T` / `t` |

The line builders (`rigctldSetFreq`, `rigctldGetFreq`, `rigctldSetMode`, `rigctldGetMode`, `rigctldSetPtt`,
`rigctldGetPtt`, `rigctldDumpState` for `\dump_state` capability negotiation) and the reply parsers
(`parseRprt`, `parseFreqReply`, `parseModeReply`) are exported on their own as well.

Setting a frequency or a mode is receive-side tuning. `setPtt` keys the transmitter: the caller must check
that the operator's callsign is control-verified before calling it.

No app or ingest box connects to `rigctld` itself.

## Next

- [Rig control & weather](../shack/rig-weather.md): the app that uses the codec.
- [Architecture and runtimes](../contribute/architecture.md): where the libraries sit.
