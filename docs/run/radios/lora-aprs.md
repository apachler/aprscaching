# LoRa APRS

This page connects a LoRa APRS iGate on your LAN to your ingest box. It is for the sysop. At the end the
LoRa stations your iGate hears are on the map, and a direct hearing can count toward Tier A.

LoRa APRS is APRS over LoRa radios on 70 cm: 433.775 MHz in IARU Region 1, 439.9125 MHz in the UK. The common
firmware (CA2RXU's LoRa_APRS_iGate and LoRa_APRS_Tracker, SQ2CPA, and the OE5BPA firmware they build on) does
not send AX.25. A packet on the air is three bytes, `0x3C 0xFF 0x01`, and then a TNC2 text line such as
`OE8APR-7>APLRT1,WIDE1-1:!4703.33N/01525.56E>`. The box's LoRa APRS port reads those packets from the iGate
and treats them like a TNC's. It never transmits.

## Before you start

- A LoRa APRS iGate with **CA2RXU LoRa_APRS_iGate** firmware, on your Wi-Fi as a client. Its **TNC server**
  serves what its radio hears on TCP port 8001. The port reads that server.
- The ingest box ([Set up an ingest box](ingest-box.md)) on the same LAN. The TNC server has no password, so
  keep it on your LAN, never on the internet.
- The iGate's radio settings: frequency, spreading factor, bandwidth and coding rate. The box does not set
  the radio. It needs the settings only for the status line and the airtime.

## 1. Switch on the iGate's TNC server

In the iGate's configuration (its web page, or `igate_conf.json`), under **TNC**:

| Setting | Value | Why |
|---|---|---|
| `enableServer` | on | Serves the packets on TCP port 8001. |
| `kissProtocol` | on (the firmware's default) or off | On: KISS frames, `LORA_APRS_PROTOCOL=kiss`. Off: one text line per packet, `LORA_APRS_PROTOCOL=text`. |
| `aprsBridgeActive` | off | On, the iGate also hands its TNC clients APRS-IS traffic. The box drops those lines (see [trust](#how-lora-aprs-traffic-is-trusted)), but they cost the iGate time. |

**Unverified**: these names come from the firmware's source, not from a test on hardware. The web page may
label them differently.

## 2. Tell the box about the iGate

In the ingest box's settings (`deploy/.env` in Docker):

```
LORA_APRS_HOST=192.168.1.30
LORA_APRS_PRESET=standard
LORA_APRS_FREQ_MHZ=433.775
```

- `LORA_APRS_HOST` is the iGate's LAN address. Setting it turns the port on.
- `LORA_APRS_PORT` is `8001` unless you changed the iGate's.
- `LORA_APRS_PROTOCOL` is `kiss` (default) or `text`, the same as the iGate's `kissProtocol`.
- `LORA_APRS_PRESET` and `LORA_APRS_FREQ_MHZ` name what the iGate's radio runs (next section).

Restart the ingest. Its log shows the settings and what a typical packet costs on the air:

```
[lora-aprs] enabled (kiss), receive only: 433.775 MHz · Standard (BW 125 kHz, SF9, CR 4:7, 1256 bit/s) · a 60-byte packet is 484 ms on air
[lora-aprs] connected 192.168.1.30:8001
```

Every setting and its default is in [Configuration](../../reference/configuration.md).

## Presets

All of a channel's stations must use the same settings, or they do not hear each other.

| Preset | `LORA_APRS_PRESET` | Bandwidth | Spreading factor | Coding rate | Bit rate | A 60-byte packet |
|---|---|---|---|---|---|---|
| Standard | `standard` | 125 kHz | SF9 | 4:7 | 1256 bit/s | 484 ms |
| Fast | `fast` | 125 kHz | SF8 | 4:6 | 2604 bit/s | 238 ms |
| Custom | `custom` | `LORA_APRS_BW_KHZ` | `LORA_APRS_SF` (7–12) | `LORA_APRS_CR` (5–8 for 4:5 to 4:8) | | |

The firmware's factory setting is SF12 with coding rate 4:5, about 300 bit/s: a 60-byte packet then takes
2.6 s on the air. Enter it as `custom` with `LORA_APRS_SF=12` and `LORA_APRS_CR=5`.

The airtime follows the LoRa time-on-air formula: an 8-symbol preamble, an explicit header and a CRC, with
low-data-rate optimisation at SF11 and SF12 on 125 kHz.

## How LoRa APRS traffic is trusted

The port is a TNC port, and the same rules apply ([Receiving site and Tier A](rf-ingest.md#receiving-site-and-tier-a)):

| The iGate… | Shown as | Can count toward Tier A? |
|---|---|---|
| heard the station **directly** | heard on RF, received by your box | **Yes**, when `RF_SITE_CALL` is a trusted receiving station |
| heard it **through a digipeater** (a hop marked `*`) | heard on RF, no receiving site | No |
| passed on an **APRS-IS** line (`aprsBridgeActive`) | dropped | No |

`RF_SITE_CALL` (default: `IGATE_CALL`) names your box as the receiving site. Trust that call on the gateway
under **Instance admin → Trusted receiving stations**, or preset it in `FIRST_PARTY_SITES`. Point the port
only at an iGate you operate: naming someone else's receiver as your site would attest hearings you cannot
vouch for.

A line that came from APRS-IS carries a q-construct (`qAR`, `qAC`, …) or `TCPIP` in its path. No packet heard
on the air does, so the box drops every such line. An APRS-IS line never counts as your hearing, whatever it
names.

The iGate's own report of each packet (RSSI, SNR, frequency error) does not reach the box: neither KISS nor
the text line carries it. Receiving never lifts trust either way.

## Check that it worked

- **Box log**: the two lines above, and every ten minutes a counters line:

  ```
  [lora-aprs] stats {"received":96,"decoded":91,"rejected":1,"fromAprsIs":4,"forms":{"lora":0,"ax25":91,"text":0},"airtimeMs":44104,"channelPct":7.35}
  ```

  `fromAprsIs` counts dropped APRS-IS lines; above zero means the iGate's `aprsBridgeActive` is on.
  `channelPct` is the share of time since the start that the packets the box heard kept the channel busy.

- **Map**: the LoRa stations' positions.
- **Port monitor**: every packet on the `lora-aprs` port.
- **`deploy/aprscaching doctor`**: the `ingest.lora_aprs` check, whether the TNC server answers.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| `[lora-aprs] disconnected, retrying…` | The TNC server is off, the iGate is not on your Wi-Fi, or `LORA_APRS_HOST` is wrong. In a container, use the iGate's LAN address ([From a container](rf-ingest.md#from-a-container)). |
| `rejected` rises, `decoded` stays at zero | `LORA_APRS_PROTOCOL` does not match the iGate's `kissProtocol`. |
| `RX frame over 65536 bytes with no closing FEND` | The iGate sends text lines: set `LORA_APRS_PROTOCOL=text`. |
| `… is a MeshCom node, not a LoRa APRS iGate` | `LORA_APRS_HOST` points at a MeshCom node. Use [MeshCom](meshcom.md) for it. |
| Positions but no Tier A | `RF_SITE_CALL` is unset or not trusted on the gateway, or the packets came through a digipeater. |

## Next

- [Receiving site and Tier A](rf-ingest.md#receiving-site-and-tier-a): how a direct hearing reaches Tier A.
- [MeshCom](meshcom.md): the other LoRa network for radio amateurs.
