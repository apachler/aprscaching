# HF APRS on 30 m

This page sets up a soundcard port for HF APRS: 300 baud on 30 m, through an SSB radio. It is for the sysop who
runs the ingest box. At the end the box hears the 30 m APRS channel and, once you allow it, transmits there.

## Before you start

- **A soundcard port** that works on VHF or UHF, or the parts for one: [Soundcard port](soundcard.md) covers the
  sound card, the cables, the PTT and the transmit gate. HF uses the same port with another modem.
- **An SSB transceiver for 30 m**, with its data or accessory jack wired to the sound card.
- **To transmit**: a licence that allows data on 30 m, and the callsigns the box transmits under
  control-verified, as on any soundcard port.

## The channel

| Setting | Value |
|---|---|
| Dial frequency | 10.1476 MHz |
| Sideband | USB |
| Tones | 1600 Hz and 1800 Hz: 200 Hz shift, centre 1700 Hz |
| Rate | 300 baud, AX.25 as on VHF |
| Path | none |

30 m is the one HF band with APRS activity worldwide. The tone pair is the one Direwolf's `MODEM 300` uses by
default, and most HF packet modems use it too.

### Dial frequency and tones

An SSB radio shifts its audio by the dial frequency. On USB the 1600 Hz tone goes out at 10.1476 + 0.0016 =
10.1492 MHz and the 1800 Hz tone at 10.1494 MHz. Every station on the channel puts its signal on these two
frequencies, so they hear each other.

- **Set the dial, never the tone frequency.** A radio dialled to 10.1493 MHz puts the signal 1.7 kHz higher, where
  nobody listens.
- **Dial it to the 10 Hz.** The tones are 200 Hz apart: a radio 100 Hz off puts each tone halfway to the other.
- **The sideband sets the dial.** On LSB the audio goes below the dial, so the same two frequencies take a dial
  of 10.1510 MHz. The modem decodes either way, because AX.25 carries its bits in the tone changes, not in which
  tone is which.

Sources: SA7SKY's [HF-APRS frequency calculation](https://privat.bahnhof.se/wb758759/tipsandtricks/HF-APRS-Frequency-Calculation.pdf)
(30 m worldwide, 10.147,6 kHz USB, tones 1600/1800 Hz); Direwolf's documentation (300 baud defaults to
1600 and 1800 Hz); G7VRD's [receive-only HF APRS IGate](https://g7vrd.co.uk/simple-receive-only-hf-aprs-igate-howto)
(`MODEM 300 1600:1800`, 10147.6 kHz USB).

## Steps

### 1. Set the radio

1. Tune to 10.1476 MHz, USB.
2. Turn off the speech processor, the noise reduction and the noise blanker: each one changes the tones.
3. Use the SSB filter, or a data filter at least 500 Hz wide centred on 1700 Hz.
4. Set the transmit level so the ALC does not act: a clean signal carries further than a loud one.

### 2. Turn the port on

In the box's settings:

```
SOUNDCARD_DEVICE=plughw:1,0
SOUNDCARD_MODEM=hf300
```

`hf300` switches the port to 300 baud and the 1600/1800 Hz tones, and gives it a 500 ms TXDELAY for an HF
radio's slower transmit-receive switching, unless `SOUNDCARD_TXDELAY_MS` names another. With a VHF port beside
it, give the HF port its own entry in `SOUNDCARD_PORTS`, with `"modem":"hf300"`
([Several ports](soundcard.md#several-ports)). Restart the ingest.

### 3. Set the receive level and allow transmit

Follow [Soundcard port](soundcard.md#3-set-the-receive-level) from step 3: the receive level, `SOUNDCARD_TX=1`,
the transmit level and the PTT test are the same on HF.

## Check that it worked

The box's status line names the port `soundcard 1 HF 300 baud`. Frames the port decodes show on the instance's
map as local RF hearings. On a quiet band, wait: the channel carries a frame every few minutes.

## What the box does on HF

- **No path.** The box's remote transmits go out with an empty path when its first radio is an HF port, unless
  `BOX_TX_PATH` names one. HF has no digipeaters, and an empty path saves the 14 bytes of `WIDE1-1,WIDE2-1`,
  0.37 s at 300 baud.
- **No digipeating.** The digipeater repeats on the box's VHF and UHF ports, never on an HF port.
- **Mic-E beacons.** A beacon on an HF radio goes out in Mic-E, nine bytes for the position. Its comment rides
  on every fourth beacon only, and the box sends at most one beacon in 10 minutes. With `BEACON=fixed` or
  `BEACON=smart` the box beacons by itself, every 10 minutes at most whatever the mode
  ([Automatic beacons](beacons.md)); a [remote beacon](remote-box.md#what-the-remote-box-app-can-do) follows the
  same limit.
- **Messages.** HF fades, so the box repeats a numbered message until the station acknowledges it: 2, 4, 8 and
  16 minutes apart, then every 30 minutes, ten tries in all
  ([Messages](../../shack/messages.md#repeats-until-acknowledged)).

## Trust

A frame the box's own HF port hears is a local RF hearing, like one from its VHF port. A frame heard on HF by
someone else's IGate reaches the instance over APRS-IS and stays
[Tier C](../../glossary.md#tier) (Logged), whatever band it started on.

## Validate at deploy

- **Unverified:** decoding real 30 m signals, with fading, a drifting radio and other stations' tone pairs.
- **Unverified:** the transmit level and the TXDELAY your radio needs.

## Next

- [Soundcard port](soundcard.md): levels, PTT, timing and the transmit gate.
- [Automatic beacons](beacons.md): let the box beacon by itself.
- [Remote control of your box](remote-box.md): queue a beacon by hand.
