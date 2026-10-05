// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * One line for each term the app uses that a new player or operator may not know, in the words of the manual's
 * glossary (docs/glossary.md), keyed by the glossary's anchor. Hints and InfoTips show these, so the app and the
 * manual speak one vocabulary; the glossary holds the longer entry.
 */
export const TERMS = {
  tier: "How a find was confirmed: A heard on the air, B the finder's phone at the cache, C logged only.",
  "minimum-tier": "The lowest tier a find here needs to count as verified. A find below it stays on record.",
  "attested-site": "A receiving station the sysop vouches for as their own. Only its hearings make a find Tier A.",
  corroboration:
    "Other instances confirming they heard the finder on the air near the cache, which can lift a find to Tier A.",
  "verified-callsign": "Proof that you control the licence you signed in with, apart from any find's tier.",
  shack: "The launcher for the ham-radio apps: packet terminal, BBS, rig control and tools such as the packet decoder.",
  ssid: "The suffix after a dash (OE8APR-7) that tells one operator's stations apart; all share the base call.",
  passcode: "The number an APRS-IS client logs in with. Anyone can work it out, so it proves nothing.",
  "aprs-is": "The internet network that carries APRS packets. A packet on it may never have been on the air.",
  "q-construct": "A tag (qAR, qAC) APRS-IS servers add to a packet's path. Anyone can write one, so it proves nothing.",
  igate: "A station that copies packets it hears on the air to APRS-IS, and optionally back.",
  digipeater: "A station that repeats packets on the air to extend their range.",
  tocall: "The destination field of an APRS packet, which names the software or device that sent it.",
  tnc: "The modem that turns radio audio into packets and back: a box, or software such as Direwolf.",
  kiss: "The simple protocol a computer uses to exchange packets with a TNC, over USB, Bluetooth or TCP.",
  netrom: "A packet-radio node that routes connections between stations.",
  bbs: "A packet-radio mailbox that stores mail and bulletins.",
  fbb: "The protocol packet BBSes use to forward mail to each other.",
  axudp:
    "AX.25 frames carried over the internet in UDP (AXUDP) or IP (AXIP): links, but internet traffic all the same.",
  mailbox: "Holds a short message for a station until the instance hears it on the air, then sends it.",
  "service-call": "The callsign this instance listens on for FOUND, DNF and other messages from the air.",
  sysop: "The ham who runs this instance: sets it up, links it to others and can verify a callsign by hand.",
  federation: "How instances share caches, finds and keys as signed records; a peer is one instance yours trusts.",
  "peer-trust":
    "Trusted peers show on the map and count toward Tier A; unvetted ones are mirrored but hidden; blocked are ignored.",
  "key-fingerprint":
    "A checksum of an instance's signing key. Sysops compare theirs over a channel they trust before trusting a peer.",
  provenance: "How a packet reached the instance, and whether one of its own receiving stations heard it directly.",
  meshcom: "A LoRa mesh network for licensed amateurs; the instance listens to a node over its ExtUDP interface.",
  watchlist: "The callsigns you follow. You get an alert when the network hears one of them.",
  "offline-pack": "The caches of one Maidenhead square, saved on this device for use without a signal.",
} as const;

export type Term = keyof typeof TERMS;
