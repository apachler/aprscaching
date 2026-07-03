// SPDX-License-Identifier: MIT
import { z } from "zod";

export const PacketKind = z.enum(["position", "message", "weather", "telemetry", "status", "object", "item", "other"]);
export type PacketKind = z.infer<typeof PacketKind>;

export const Packet = z.object({
  src: z.string(),
  dst: z.string().optional(),
  path: z.array(z.string()).default([]),
  payload: z.string(),
  kind: PacketKind.default("other"),
  parsed: z.record(z.string(), z.unknown()).optional(),
  heardVia: z.enum(["rf", "aprs_is", "app"]).default("aprs_is"),
  igateCall: z.string().optional(),
  port: z.string().default("aprs-is"),
  ts: z.number(),
  raw: z.string().optional(),
});
export type Packet = z.infer<typeof Packet>;

/** Hard batch ceiling (SR-SEC-10): the ingest box flushes every few seconds, so a legitimate batch
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
 * `firstPartyAttested` alone — never on `transport`. The enum keeps the deferred
 * RF / AXIP / HAMNET tracks pluggable without re-touching the trust engine.
 */
export const Transport = z.enum([
  "aprs-is", // APRS-IS firehose (the only wired transport today)
  "app", // first-party in-app device geolocation (the Tier-B path)
  "axudp", // AX.25 over UDP (BPQ node mesh) — ingest listener/port built, feature-flagged off
  "axip", // AX.25 over raw IP proto 93 — ingest listener built (raw socket), feature-flagged off
  "hamnet-kiss", // KISS-over-IP from a HAMNET site — reserved
  "first-party-rf", // a receiver we operate + attest — the only Tier-A origin
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
