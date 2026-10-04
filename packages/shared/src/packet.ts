// SPDX-License-Identifier: MIT
import { z } from "zod";

export const PacketKind = z.enum(["position", "message", "weather", "telemetry", "status", "object", "item", "other"]);
export type PacketKind = z.infer<typeof PacketKind>;

/**
 * Field ceilings for an ingested packet. An APRS-IS line is at most 512 bytes and an AX.25 info field 256,
 * so the payload and the whole line fit 512. A callsign is at most 9 characters (MeshCom's SSID letters
 * included); 16 leaves room for the other station names APRS-IS carries. A path element may be a q-construct
 * server name or the 32-hex-digit form of an IPv6 address.
 */
export const PACKET_LINE_MAX = 512;
const CALL_MAX = 16;
const PATH_ELEM_MAX = 32;
const PATH_MAX = 32;

export const Packet = z.object({
  src: z.string().max(CALL_MAX),
  dst: z.string().max(CALL_MAX).optional(),
  path: z.array(z.string().max(PATH_ELEM_MAX)).max(PATH_MAX).default([]),
  payload: z.string().max(PACKET_LINE_MAX),
  kind: PacketKind.default("other"),
  parsed: z.record(z.string(), z.unknown()).optional(),
  heardVia: z.enum(["rf", "aprs_is", "app"]).default("aprs_is"),
  igateCall: z.string().max(CALL_MAX).optional(),
  port: z.string().max(64).default("aprs-is"),
  // The ingest box (its BOX_ID) and the station on it that received this frame over its own radio —
  // where an answer to the sender can be transmitted from. Routing only: never a trust input.
  box: z.string().max(64).optional(),
  rxCall: z.string().max(16).optional(),
  ts: z.number(),
  raw: z.string().max(PACKET_LINE_MAX).optional(),
});
export type Packet = z.infer<typeof Packet>;

/** Hard batch ceiling: the ingest box flushes every few seconds, so a legitimate batch
 *  is tens of packets — 1000 absorbs any reconnect backlog while bounding a hostile POST. */
export const INGEST_BATCH_MAX = 1000;
export const IngestBatch = z.object({ packets: z.array(Packet).max(INGEST_BATCH_MAX) });
export type IngestBatch = z.infer<typeof IngestBatch>;

/**
 * Provenance — the transport-vs-trust seam.
 *
 * The wire a packet arrives on is NOT proof it touched RF. APRS-IS, an AXIP/AXUDP
 * tunnel and a HAMNET-bridged KISS link are all just transports; none of them, on
 * their own, corroborate presence. Only a receiving site WE operate and can attest
 * for yields Tier-A uplift. So the verification engine MUST branch on
 * `firstPartyAttested` alone — never on `transport`. The enum keeps the
 * RF / AXIP / HAMNET transports pluggable without re-touching the trust engine.
 */
export const Transport = z.enum([
  "aprs-is", // the APRS-IS feed
  "app", // first-party in-app device geolocation (the Tier-B path)
  "tnc", // a local TNC on the ingest box: KISS, AGWPE or WA8DED host mode
  "browser-rf", // the browser RF bridge (Web Serial / Web Bluetooth), a signed batch
  "axudp", // AX.25 over UDP (BPQ node mesh)
  "axip", // AX.25 over raw IP proto 93
  "meshcom", // MeshCom LoRa mesh via a node's ExtUDP interface
  "meshtastic", // Meshtastic via the MQTT bridge or the browser
  "hamnet-kiss", // KISS-over-IP from a HAMNET site — reserved, no listener sets it
  "first-party-rf", // reserved, no listener sets it; attestation is the firstPartyAttested flag, never a transport
  "unknown", // an ingest port the gateway does not know; never attested
]);
export type Transport = z.infer<typeof Transport>;

export const Provenance = z.object({
  transport: Transport,
  qConstruct: z.string().optional(), // APRS-IS path token (qAR ≈ RF-originated)
  firstPartyAttested: z.boolean(), // heard at a site we operate + attest — the ONLY Tier-A gate
  siteId: z.string().optional(), // the attesting receiver/IGate id
  heardAt: z.number().optional(), // unix seconds the site heard it
});
export type Provenance = z.infer<typeof Provenance>;
