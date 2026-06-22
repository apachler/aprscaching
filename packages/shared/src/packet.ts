import { z } from "zod";

export const PacketKind = z.enum([
  "position", "message", "weather", "telemetry", "status", "object", "item", "other",
]);
export type PacketKind = z.infer<typeof PacketKind>;

export const Packet = z.object({
  src: z.string(),
  dst: z.string().optional(),
  path: z.array(z.string()).default([]),
  payload: z.string(),
  kind: PacketKind.default("other"),
  parsed: z.record(z.unknown()).optional(),
  heardVia: z.enum(["rf", "aprs_is", "app"]).default("aprs_is"),
  igateCall: z.string().optional(),
  port: z.string().default("aprs-is"),
  ts: z.number(),
  raw: z.string().optional(),
});
export type Packet = z.infer<typeof Packet>;

export const IngestBatch = z.object({ packets: z.array(Packet) });
export type IngestBatch = z.infer<typeof IngestBatch>;
