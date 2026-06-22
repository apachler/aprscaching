import { z } from "zod";

export const CacheType = z.enum([
  "single", "two_stage", "multi", "aprs_living", "audio", "traditional", "sota", "pota",
]);
export const TrustTier = z.enum(["A", "B", "C"]);

export const LogFindRequest = z.object({
  cacheId: z.number(),
  loggerCall: z.string(),
  comment: z.string().optional(),
  appGeo: z.object({ lat: z.number(), lon: z.number(), accuracyM: z.number(), ts: z.number() }).optional(),
});
export type LogFindRequest = z.infer<typeof LogFindRequest>;
