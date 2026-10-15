// SPDX-License-Identifier: MIT
/**
 * heard.ts — the station-health contract of the read API: when a callsign was last heard, where, over which
 * route, and what it last said, for a script (Node-RED, a home-automation box) that watches a station.
 *
 *   GET /api/v1/station/:call/heard              the latest {@link StationHeard} snapshot
 *   GET /api/v1/stations/heard/stream?calls=A,B  Server-Sent Events: one `heard` event per {@link HeardEvent}
 *
 * Everything here is what the station itself put on the air: its position, path, comment and status text. No
 * account, owner or registry field is part of it.
 */
import { z } from "zod";

/** The most callsigns one stream watches. */
export const HEARD_STREAM_MAX_CALLS = 20;
/** Streams one client holds open at once: per IP without a key, per key with one. */
export const HEARD_STREAM_MAX_OPEN = { anonymous: 2, keyed: 10 } as const;
/** Seconds between the stream's keep-alive comments. */
export const HEARD_STREAM_KEEPALIVE_SEC = 15;

/**
 * How a packet reached this instance: heard on the air by an ingest (`rf`), carried by APRS-IS (`aprs_is`), or
 * sent by the phone app (`app`).
 */
export const HeardVia = z.enum(["rf", "aprs_is", "app"]);
export type HeardVia = z.infer<typeof HeardVia>;

export const HeardPosition = z.object({
  lat: z.number(),
  lon: z.number(),
  symbol: z.string().optional(),
  course: z.number().optional(),
  speedKn: z.number().optional(),
});
export type HeardPosition = z.infer<typeof HeardPosition>;

/** One packet of a watched station, as the stream pushes it. */
export const HeardEvent = z.object({
  type: z.literal("heard"),
  callsign: z.string(),
  /** Unix seconds the packet was heard. */
  ts: z.number(),
  via: HeardVia,
  /** The APRS digipeater path, the q-construct and the gating IGate included. */
  path: z.array(z.string()),
  /** Present when the packet carried a position. */
  position: HeardPosition.optional(),
  /** Present when the packet was a status report (`>`). */
  status: z.string().optional(),
});
export type HeardEvent = z.infer<typeof HeardEvent>;

/** The answer of `GET /api/v1/station/:call/heard`. */
export const StationHeard = z.object({
  callsign: z.string(),
  /** Unix seconds of the latest packet this instance holds from the station; null when it holds none. */
  lastHeard: z.number().nullable(),
  /** How the latest packet arrived, and its path. */
  via: HeardVia.nullable(),
  path: z.array(z.string()),
  /** The latest position and when it was heard. */
  position: HeardPosition.extend({ ts: z.number() }).nullable(),
  /** The latest position comment. */
  comment: z.string().nullable(),
  /** The latest status text and when it was heard. */
  status: z.object({ text: z.string(), ts: z.number() }).nullable(),
  /**
   * Pass back as `?since=` on the next request: `changed` then says whether anything was heard after it. Equal to
   * `lastHeard`, or 0 when nothing was heard.
   */
  cursor: z.number(),
  /** False when `?since=` was given and nothing was heard after it. */
  changed: z.boolean(),
});
export type StationHeard = z.infer<typeof StationHeard>;
