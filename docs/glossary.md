# Glossary

Short definitions of the radio and platform terms the manual uses. Each entry links to the page that
explains it in full.

## Radio and APRS

<span id="aprs"></span>APRS
:   Automatic Packet Reporting System: amateur radio's shared channel for positions, short messages,
    weather and status. Each report is a small *packet* carrying the sender's callsign.

<span id="aprs-is"></span>APRS-IS
:   The APRS Internet Service: a worldwide network of servers that carries APRS packets over the internet.
    Anything on it may never have been on the air, so it proves nothing about where a station was
    ([Transport is not trust](reference/trust-model.md#transport-is-not-trust)).

<span id="passcode"></span>Passcode
:   The number an APRS-IS client logs in with. It is derived from the callsign by a public formula, so it
    proves nothing about who holds the call.

<span id="igate"></span>IGate
:   Internet gateway: a station that copies packets it hears on the air to APRS-IS, and optionally the
    other way ([IGate](run/radios/rf-ingest.md#igate)).

<span id="digipeater"></span>Digipeater
:   A station that repeats packets on the air to extend their range
    ([Digipeater](run/radios/rf-ingest.md#digipeater)).

<span id="q-construct"></span>q-construct
:   A tag APRS-IS servers add to a packet's path (`qAR`, `qAC`, …) naming how and where it entered
    APRS-IS. Anyone with a passcode can write one, so aprscaching never treats it as proof of a hearing.

<span id="callsign"></span><span id="ssid"></span>Callsign and SSID
:   Your licence callsign identifies you on the air. An **SSID** is the suffix after a dash (`OE8APR-7`)
    that tells one operator's stations apart; every SSID belongs to the same base call
    ([Several callsigns](play/account.md#several-callsigns)).

<span id="ax25"></span>AX.25
:   The data-link protocol amateur packet radio runs on; every APRS packet is an AX.25 frame
    ([Connected-mode AX.25](contribute/ax25-stack.md)).

<span id="tnc"></span>TNC
:   Terminal node controller: the modem that turns radio audio into packets and back, either a box between
    computer and radio or software such as Direwolf.

<span id="kiss"></span>KISS
:   The simple protocol a computer uses to exchange packets with a TNC, over USB, serial, Bluetooth or TCP
    ([Your radio in the browser](shack/my-radio.md)).

<span id="afsk"></span>AFSK
:   Audio frequency-shift keying: how 1200-baud APRS sounds on the air. The browser can decode and send it
    through a sound card.

<span id="cat"></span><span id="ci-v"></span>CAT and CI-V
:   CAT (computer-aided transceiver) is the serial control a computer uses to tune a radio; **CI-V** is
    Icom's version of it ([Rig control & weather](shack/rig-weather.md#cat-rig-control)).

<span id="netrom"></span><span id="bbs"></span><span id="fbb"></span>NET/ROM, BBS and FBB
:   Classic packet-radio services: a **NET/ROM** node routes connections between stations, a **BBS** stores
    mail and bulletins, and **FBB** is the protocol BBSes use to forward mail to each other
    ([Packet BBS & node](run/radios/packet-node.md)).

<span id="axudp"></span><span id="axip"></span>AXUDP and AXIP
:   AX.25 frames carried over the internet (in UDP, or directly in IP). Useful links between nodes, but
    internet traffic all the same ([AXUDP and AXIP peering](run/networks/44net.md#axudp-and-axip-peering-over-44net)).

<span id="meshcom"></span><span id="extudp"></span>MeshCom
:   A LoRa mesh network for licensed amateurs. aprscaching listens to a MeshCom node on the operator's
    network through the node's **ExtUDP** interface ([MeshCom](run/radios/meshcom.md)).

<span id="meshtastic"></span>Meshtastic
:   A LoRa mesh system; aprscaching shows only nodes in licensed mode, which carry a callsign.

<span id="44net"></span><span id="amprnet"></span><span id="hamnet"></span>44Net, AMPRNet and HAMNET
:   **44Net** (AMPRNet) is the amateur-radio IPv4 space in `44.x`, administered by ARDC; `<call>.ampr.org`
    names live in it. **HAMNET** is the amateur microwave IP network ([Run an instance on
    44Net](run/networks/44net.md)).

<span id="lotw"></span>LoTW
:   Logbook of The World, ARRL's contest and award log. Its callsign certificate can prove you hold a call
    ([LoTW certificate](play/join.md#lotw-certificate)).

<span id="cwop"></span><span id="pws"></span>CWOP and PWS
:   A **PWS** is a personal weather station; **CWOP** (Citizen Weather Observer Program) collects their
    readings ([Weather stations](shack/rig-weather.md#weather-stations)).

<span id="maidenhead"></span>Maidenhead locator
:   A grid square such as `JN77pb` that names a location in a few characters; hams use it in place of
    coordinates.

## aprscaching

<span id="instance"></span>Instance
:   One running aprscaching server, run by a ham for their region or club. Instances share caches and
    finds through federation.

<span id="sysop"></span>Sysop
:   The operator who runs an instance. Their callsign is listed in `ADMIN_CALLSIGNS`
    ([Instance admin at a glance](run/day-to-day/index.md)).

<span id="shack"></span>The Shack
:   The launcher for the ham-radio apps — packet terminal, BBS, decoder, rig control and more
    ([The Shack at a glance](shack/index.md)).

<span id="find"></span><span id="dnf"></span>Find, DNF and note
:   A **find** logs that you found a cache; **DNF** ("did not find") logs that you looked and did not; a
    **note** is a comment without either ([Log a find](play/log-a-find.md)).

<span id="tier"></span>Tier A, B and C
:   How strongly a find is verified: **A** radio-verified, **B** location-verified by the app, **C** logged
    but unverified ([Verification tiers](reference/trust-model.md#verification-tiers)).

<span id="verified-callsign"></span>Verified callsign
:   Proof that you control the licence you signed in with — separate from a find's tier
    ([Verify your callsign](play/join.md#verify-your-callsign)).

<span id="attested-site"></span>Attested site
:   A receiving station the sysop vouches for as their own: its radio and ingest box are theirs. Only a
    direct hearing at an attested site can make a find Tier A
    ([Receiving site and Tier A](run/radios/rf-ingest.md#receiving-site-and-tier-a)).

<span id="ingest-box"></span>Ingest box
:   The program (`apps/ingest`) on the operator's own computer that connects radios and APRS-IS to the
    instance ([RF ingest & transports](run/radios/rf-ingest.md)).

<span id="provenance"></span>Provenance
:   The record of how a packet reached the instance and whether an attested site heard it directly. The
    verification engine reads only this, never the raw transport
    ([Transport is not trust](reference/trust-model.md#transport-is-not-trust)).

<span id="corroboration"></span>Corroboration
:   Asking other instances whether they independently heard a finder on the air near the cache; enough
    agreeing instances can lift a find to Tier A
    ([Corroboration and quorum](reference/trust-model.md#corroboration-and-quorum)).

<span id="federation"></span><span id="peer"></span>Federation and peer
:   **Federation** is how instances share caches, finds and keys as signed records; a **peer** is another
    instance yours exchanges them with ([Join the network](run/federation/index.md)).

<span id="tombstone"></span>Tombstone
:   A signed deletion record. It travels through federation so erased data is removed everywhere and never
    mirrored again.

<span id="passkey"></span>Passkey
:   A sign-in key stored on your device, used instead of a password ([Sign in](play/join.md#sign-in)).

<span id="living-cache"></span>Living cache
:   A cache that moves with an APRS station: you find it by meeting the station
    ([Cache types](play/cache-types/index.md)).

## Next

- [What is APRScaching?](play/index.md).
