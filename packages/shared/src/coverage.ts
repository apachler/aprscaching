// SPDX-License-Identifier: MIT
/**
 * coverage.ts — the radio-coverage contract behind the hide form's map (`GET /api/v1/coverage?bbox=`).
 *
 * A coverage site is a receiving station drawn as a range circle: an attested receiving site (its hearings make
 * a find Tier A), or a digipeater or IGate heard on the air whose hearings reach the instance over APRS-IS (Tier C
 * unless an attested site hears the frame too). The range is the one the station advertises (PHG or RNG), or a
 * conservative default marked `estimated` when it advertises none.
 */
import { z } from "zod";

/** The kind of a coverage site: an attested receiving site, or a digipeater or IGate. */
export const CoverageKind = z.enum(["attested", "digipeater", "igate"]);
export type CoverageKind = z.infer<typeof CoverageKind>;

/**
 * The range a station that advertises none is drawn with, in kilometres. Conservative on purpose: a hider who
 * trusts the circle must not place a cache where the radio does not reach. A digipeater usually sits high to
 * relay; an IGate or a receiving site is as often a home station with a modest antenna.
 */
export const COVERAGE_DEFAULT_KM = { digipeater: 10, receiver: 5 } as const;
/** The widest circle drawn, in kilometres: a PHG or RNG beyond it is drawn at this radius. */
export const COVERAGE_MAX_KM = 100;
/** The most sites one answer carries. */
export const COVERAGE_MAX_SITES = 300;

export const CoverageSite = z.object({
  callsign: z.string(),
  lat: z.number(),
  lon: z.number(),
  kind: CoverageKind,
  /** The radius drawn, in kilometres. */
  rangeKm: z.number().positive(),
  /** True when the station advertises no range and `rangeKm` is the default for its kind. */
  estimated: z.boolean(),
  /** Unix seconds of the station's last position. */
  lastSeen: z.number(),
});
export type CoverageSite = z.infer<typeof CoverageSite>;

export const CoverageResponse = z.object({
  sites: z.array(CoverageSite),
  /** True when the box held more sites than one answer carries. */
  truncated: z.boolean(),
});
export type CoverageResponse = z.infer<typeof CoverageResponse>;
