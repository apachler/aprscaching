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
    APRS-IS. Anyone with a passcode can write one, so APRScaching never treats it as proof of a hearing.

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
:   A LoRa mesh network for licensed amateurs. APRScaching listens to a MeshCom node on the operator's
    network through the node's **ExtUDP** interface ([MeshCom](run/radios/meshcom.md)).

<span id="meshtastic"></span>Meshtastic
:   A LoRa mesh system; APRScaching shows only nodes in licensed mode, which carry a callsign.

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

## APRScaching

<span id="instance"></span>Instance
:   One running APRScaching server, run by a ham or a club for their region. Instances link up and share
    caches and finds; the one your account lives on is your home instance
    ([Getting to your instance](play/your-instance.md)).

<span id="home-instance"></span><span id="remote-cache"></span>Home instance and remote cache
:   Your **home instance** is the one your account lives on: you sign in and log there. A **remote cache**
    comes from another instance in the network; it shows *mirrored from* its home, and you log it there
    ([Getting to your instance](play/your-instance.md)).

<span id="sysop"></span>Sysop
:   The ham who runs an instance. They set it up, link it to others, and can verify a callsign by hand or
    offer a cache for adoption ([Instance admin at a glance](run/day-to-day/index.md)).

<span id="shack"></span>The Shack
:   The launcher for the ham-radio apps — packet terminal, BBS, decoder, rig control and more
    ([The Shack at a glance](shack/index.md)).

<span id="find"></span><span id="dnf"></span>Find, DNF and note
:   A **find** logs that you found a cache; **DNF** ("did not find") logs that you looked and did not; a
    **note** is a comment without either ([Log a find](play/log-a-find.md)).

<span id="difficulty"></span><span id="terrain"></span>Difficulty and terrain (D/T)
:   Two ratings from 1 to 5, in half steps, that the hider sets: how hard the cache is to find, and how hard
    the place is to reach. Both add to the points a find earns
    ([Open the cache sheet](play/find-a-cache.md#open-the-cache-sheet)).

<span id="stage"></span><span id="unlock"></span><span id="nfc-stage"></span>Stage, unlock and NFC stage
:   A **stage** is one step of a multi-stage cache. You **unlock** the next stage at the current one: by
    standing there, by following a clue, or at an **NFC stage** by scanning the tag or typing the code printed
    on it ([Multi-stage caches](play/cache-types/multi.md)).

<span id="tier"></span><span id="radio-verified"></span><span id="location-verified"></span><span id="logged"></span>Radio-verified, Location-verified and Logged (Tier A, B and C)
:   How strongly a find is verified. **Radio-verified** (A): a receiving station that isn't yours heard your
    APRS position on the air near the cache. **Location-verified** (B): your phone's location matched the
    cache. **Logged** (C): nothing independent placed you there; the find is recorded but not verified
    ([How finds are verified](play/verification.md)).

<span id="minimum-tier"></span>Minimum tier
:   The lowest tier a cache counts as verified, shown on the cache sheet as **Verification · Location-verified
    or better**. A find below it stays on record but does not count as verified
    ([Open the cache sheet](play/find-a-cache.md#open-the-cache-sheet)).

<span id="verified-callsign"></span>Verified callsign
:   Proof that you control the licence you signed in with — separate from a find's tier
    ([Verify your callsign](play/join.md#verify-your-callsign)).

<span id="attested-site"></span>Attested site
:   A receiving station the sysop vouches for as their own. Only a direct hearing at an attested site can
    make a find Radio-verified
    ([Receiving site and Tier A](run/radios/rf-ingest.md#receiving-site-and-tier-a)).

<span id="ingest-box"></span>Ingest box
:   The program on the operator's own computer that connects their radios and APRS-IS to the
    instance ([RF ingest & transports](run/radios/rf-ingest.md)).

<span id="provenance"></span>Provenance
:   The record of how a packet reached the instance, and whether one of the instance's own receiving
    stations heard it directly. Only that record, never the path a packet took, counts toward verification
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
:   A sign-in key stored on your device, used instead of a password. Each device holds its own, or shares one
    through your password manager ([How a passkey keeps your account yours](play/join.md#how-a-passkey-keeps-your-account-yours)).

<span id="sign-in-link"></span>One-time sign-in link
:   A link that signs you in once, within 15 minutes. You get it by email, or from the sysop where the
    instance has no https and no email, such as on HAMNET
    ([Getting to your instance](play/your-instance.md#what-works-on-each-way-in)).

<span id="living-cache"></span>Living cache
:   A cache that moves with an APRS station: you find it by meeting the station
    ([Cache types](play/cache-types/index.md)).

<span id="rendezvous"></span>Rendezvous
:   A record made when two living caches meet: within 150 m of each other inside 15 minutes. It shows on both
    cache pages, with the time for the cache's owner and the day for everyone else, and earns no points ([Living caches](play/cache-types/living.md#rendezvous)).

<span id="heritage-place"></span><span id="heritage-cache"></span>Heritage place
:   A summit, park, castle or other place from an award programme or open map data, imported by the sysop so
    it shows as a cache. You find and log it like any other cache
    ([Heritage places](play/cache-types/heritage.md)).

<span id="adoption"></span>Adoption
:   Handing a cache on when its owner leaves. The sysop offers it, a player with a verified callsign asks for
    it, and the cache changes hands with its finds and logbook
    ([Cache adoption](play/hide-a-cache.md#cache-adoption)).

<span id="needs-maintenance"></span>Needs maintenance
:   A flag on a cache whose last three find or did-not-find logs are all DNFs. It tells the owner to check the
    cache ([Maintain your cache](play/hide-a-cache.md#maintain-your-cache)).

<span id="favourite"></span>Favourite
:   A heart (♡) you give a cache you like. The cache sheet shows how many players gave it one
    ([Favourites](play/community.md#favourites)).

<span id="badge"></span>Badge
:   An award on your profile for verified finds and hides: your first find, 10 to 500 finds, a Radio-verified
    find, finds of some cache types, and hidden caches. A find's tier label is a different thing
    ([Badges](play/community.md#badges)).

<span id="watchlist"></span>Watchlist
:   The callsigns you follow. When the network hears one of them, you get an alert in the app, by push or
    in the email digest ([Alerts and the watchlist](play/community.md#alerts-and-the-watchlist)).

<span id="offline-pack"></span>Offline pack
:   The caches of one Maidenhead square, saved on your phone for use without a signal: up to 5000 caches, with
    their hints, latest logs and, where the instance offers one, the map
    ([Offline packs](play/offline.md#offline-packs)).

<span id="service-call"></span>Service call
:   The callsign an instance listens on for APRS and MeshCom messages, `APRSCG` unless the instance names
    another. You send it `FOUND`, `DNF`, `NOTE` or `VERIFY` messages
    ([Log from your radio](play/log-a-find.md#log-from-your-radio)).

## Next

- [What is APRScaching?](play/index.md).
