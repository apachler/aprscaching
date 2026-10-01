// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * How long the nightly job keeps the diagnostic and telemetry tables. These rings exist for the
 * Shack and for troubleshooting, never for verification, so they are short by default. An operator
 * may shorten or lengthen any of them with one JSON setting, e.g.
 * `RETENTION={"packetsHours":6,"sensorDays":90}`; an absent, non-numeric or non-positive value keeps
 * the default.
 */
import type { Env } from "./env.js";
import { jsonObjectSetting } from "./util/config.js";

export const RETENTION_DEFAULTS = {
  /** The Shack raw-packet ring (packets_recent), in hours. */
  packetsHours: 24,
  /** The firehose message log. */
  messagesDays: 7,
  /** Weather and telemetry readings. */
  sensorDays: 30,
  /** Per-port RX/TX counters. */
  portStatsDays: 7,
  /** Watch alerts the user has seen. */
  alertsDays: 30,
  /** NET/ROM node MHeard rows. */
  mheardDays: 7,
};
type Retention = typeof RETENTION_DEFAULTS;

export function retentionFrom(env: Env): Retention {
  const set = jsonObjectSetting(env.RETENTION);
  const out = { ...RETENTION_DEFAULTS };
  for (const k of Object.keys(out) as (keyof Retention)[]) {
    const v = set[k];
    if (typeof v === "number" && Number.isFinite(v) && v > 0) out[k] = v;
  }
  return out;
}

/**
 * How long the nightly prune keeps firehose and browser-bridge positions. Fixed rather than in RETENTION:
 * these are verification evidence, and a signed field time never reaches further back (fieldtime.ts).
 */
export const POSITION_RETENTION_S = 7 * 24 * 3600;
