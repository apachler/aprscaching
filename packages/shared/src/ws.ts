// SPDX-License-Identifier: MIT
import { z } from "zod";

export const Subscribe = z.object({
  type: z.literal("subscribe"),
  bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]),
  maxAgeSec: z.number().default(3600),
  callsign: z.string().optional(),
});
export type Subscribe = z.infer<typeof Subscribe>;

export const StationDelta = z.object({
  type: z.literal("station"),
  callsign: z.string(), lat: z.number(), lon: z.number(),
  course: z.number().optional(), symbol: z.string().optional(), lastSeen: z.number(),
});
export type StationDelta = z.infer<typeof StationDelta>;

export const GeofencePrompt = z.object({
  type: z.literal("near_cache"),
  cacheId: z.number(), code: z.string(), title: z.string(), distanceM: z.number(),
});
export type GeofencePrompt = z.infer<typeof GeofencePrompt>;

export const ServerMsg = z.discriminatedUnion("type", [StationDelta, GeofencePrompt]);
export type ServerMsg = z.infer<typeof ServerMsg>;
