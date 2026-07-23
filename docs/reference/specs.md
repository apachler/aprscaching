# Specification registry

Every protocol and format the platform implements is built from the open, publicly available
specifications below — never from another project's closed source. This registry is the single
place that names each specification, what the platform implements from it, and where the
authoritative document lives.

Link rot is real in the packet-radio world: where the original host has vanished, the table lists
the best surviving authoritative source and says so.

## Radio & packet protocols

| Specification | What the platform implements | Authoritative document |
|---|---|---|
| **APRS Protocol Reference 1.01** (+ 1.1/1.2 addenda) | Position/status/message/object/weather/telemetry encoding + decoding, symbols, Mic-E, the `APZ*` experimental tocall | [APRS101.PDF](http://www.aprs.org/doc/APRS101.PDF) · [1.1 addendum](https://www.aprs.org/aprs11.html) · [1.2 proposals](https://www.aprs.org/aprs12.html) · maintained successor: [APRS Protocol Spec 1.2 (WB2OSZ)](https://github.com/wb2osz/aprsspec) |
| **APRS-IS** | Client login, server-side filters, q-constructs (`qAR`/`qAC`/`qAX`), third-party encapsulation, passcode | [Connecting to APRS-IS](https://www.aprs-is.net/connecting.aspx) · [q Construct](https://www.aprs-is.net/q.aspx) · [q Algorithm](https://www.aprs-is.net/qalgorithm.aspx) |
| **AX.25 v2.2** | UI + connected-mode frames, SABM/UA/DISC, I/RR/REJ, digipeater path handling | [AX.25 Link Access Protocol v2.2](https://www.ax25.net/AX25.2.2-Jul%2098-2.pdf) |
| **KISS** | TNC framing over serial/TCP (FEND/FESC escaping, port commands) | [The KISS TNC (K3MC/KA9Q, 1987)](http://www.ka9q.net/papers/kiss.html) |
| **AGWPE TCP/IP API** | The AGW socket frame protocol the ingest and terminal drivers speak | [SV2AGW developer page](https://www.sv2agw.com/Home/Developers) · [API tutorial mirror (ON7LDS)](https://www.on7lds.net/42/sites/default/files/AGWPEAPI.HTM) |
| **WA8DED hostmode** | The terminal's hostmode TNC driver | best surviving reference: the WA8DED/TF documentation mirrored in packet archives ([packet-radio.net docs](https://packet-radio.net/docs/)) |
| **AXIP / AXUDP** | AX.25-over-IP encapsulation (protocol 93 / UDP) between nodes | conventions documented with ax25ipd in the [Linux AX.25 tools](https://www.linux-ax25.org/) |
| **FBB forwarding** | MBL/RLI + FBB proposals (`FA`/`FB`/`FS`), BIDs, hierarchical routing, resume offsets, MD5 auth, B0/B1 compressed forwarding | [FBB protocols overview](https://www.f6fbb.org/protocole.html) · [forward protocol](https://www.f6fbb.org/fbbdoc/docfwpro.htm) · [compressed forward](https://www.f6fbb.org/fbbdoc/docfwcom.htm) |
| **LZHUF** | The LZSS+adaptive-Huffman codec FBB B1 transfers use (independent implementation of the public Okumura/Yoshizaki algorithm) | [LZHUF.C reference source](https://github.com/e-n-f/lzss/blob/master/LZHUF.C) · [format notes](http://fileformats.archiveteam.org/wiki/LZHUF) |
| **NET/ROM** | NODES broadcasts, routing table, connected-mode circuits, sysop command set | no stable canonical URL survives for the 1987 Software 2000 manual — best living references: [packet-radio.net docs](https://packet-radio.net/docs/) · [Linux NET/ROM node HOWTO](https://tldp.org/HOWTO/pdf/Netrom-Node.pdf) |
| **INP3 (Improved NET/ROM)** | RIF/L3RTT routing exchange with split-horizon triggered updates | [INP3 protocol (G8PZT, via XRouter docs)](https://ohiopacket.org/xrpi/docs/inp3.htm) |
| **Bell 202 AFSK** | 1200-baud soundcard modem tones (1200/2200 Hz) for the browser AFSK path | no authoritative Bell PUB 41212 scan survives online — [descriptive reference](https://en.wikipedia.org/wiki/Bell_202) |
| **Meshtastic®** | The JSON gateway output (ingest bridge) and the serial client API framing (browser path) | [Client API](https://meshtastic.org/docs/development/device/client-api/) · [protobufs](https://github.com/meshtastic/protobufs) |
| **CWOP** | APRS-IS-style weather relay to the Citizen Weather Observer Program | [wxqa.com](http://www.wxqa.com/) · [CWOP guide](https://weather.gladstonefamily.net/CWOP_Guide.pdf) |
| **Peet Bros Ultimeter** | Serial weather-station frames at the ingest box | [Peet Bros data logging protocols](https://www.peetbros.com/shop/custom.aspx?recid=29) |
| **Hamlib rigctld** | Rig tuning over the rigctld TCP wire protocol (Hamlib itself is never linked — `packages/*` stay MIT-clean) | [Hamlib rigctld man page](https://hamlib.sourceforge.net/html/rigctld.1.html) |

## Data formats & geodesy

| Specification | What the platform implements | Authoritative document |
|---|---|---|
| **ADIF** | Log export records | [ADIF specification](https://www.adif.org/) |
| **GPX 1.1** | Cache/track export | [GPX 1.1 schema](https://www.topografix.com/GPX/1/1/) |
| **KML** (OGC) | Cache/track export | [OGC KML standard](https://www.ogc.org/standards/kml/) |
| **Cursor on Target (CoT)** | The TAK-consumable event feed (base-event schema v2.0) | [MITRE CoT router guide](https://www.mitre.org/sites/default/files/pdf/09_4937.pdf) · [public-release base schema](https://github.com/deptofdefense/AndroidTacticalAssaultKit-CIV/blob/main/takcot/mitre/CoT%20Base-Event%20Schema%20%20(PUBLIC%20RELEASE).xsd) |
| **Maidenhead locator** | 10-character grid encode/decode | [ARRL grid squares](http://www.arrl.org/grids) |
| **MGRS** | Military-grid readout on the map | [DMA TM 8358.1 (DTIC)](https://apps.dtic.mil/sti/tr/pdf/ADA247651.pdf) |

## Web & security standards

| Specification | What the platform implements | Authoritative document |
|---|---|---|
| **WebAuthn** (W3C) | Passkey registration/authentication | [W3C WebAuthn](https://www.w3.org/TR/webauthn-3/) |
| **RFC 8032** | Ed25519 signatures (federation records, device keys, tool manifests) | [rfc-editor.org/rfc/rfc8032](https://www.rfc-editor.org/rfc/rfc8032) |
| **RFC 8291 / 8292** | Web-push message encryption + VAPID | [rfc-editor.org/rfc/rfc8291](https://www.rfc-editor.org/rfc/rfc8291) · [rfc-editor.org/rfc/rfc8292](https://www.rfc-editor.org/rfc/rfc8292) |
| **RFC 8484** | DNS-over-HTTPS for 44net peer verification | [rfc-editor.org/rfc/rfc8484](https://www.rfc-editor.org/rfc/rfc8484) |
| **RFC 6455** | WebSockets (live map, terminal) | [rfc-editor.org/rfc/rfc6455](https://www.rfc-editor.org/rfc/rfc6455) |
| **RFC 8949** | Deterministic CBOR (the federation wire format) | [rfc-editor.org/rfc/rfc8949](https://www.rfc-editor.org/rfc/rfc8949) |
| **ISO/IEC 18004** | The dependency-free QR encoder (cache share codes) | [ISO/IEC 18004](https://www.iso.org/standard/62021.html) |
| **Web Serial / Web Bluetooth** | The browser RF bridge (USB KISS TNC, BLE-KISS, Meshtastic over serial) | [Web Serial (WICG)](https://wicg.github.io/serial/) · [Web Bluetooth (CG)](https://webbluetoothcg.github.io/web-bluetooth/) |

*Meshtastic® is a registered trademark of Meshtastic LLC. APRS® is a registered trademark of Bob
Bruninga, WB4APR. This project is not affiliated with or endorsed by either — the names identify
the protocols it interoperates with.*
