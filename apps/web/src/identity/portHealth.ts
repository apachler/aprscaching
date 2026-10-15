// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * A transport port's status line in Instance admin: its packets per second, the share of frames whose APRS
 * payload decoded, the frames that were not a packet at all, and what the gateway received, over 24 hours.
 * The first three come from the ingest box's reports; a port it never reported on shows its RX count alone.
 */
import type { PortStat } from "@aprscaching/shared";

/** The parts of a port's status line, in order: `0.4 pkt/s`, `98% parsed`, `3 invalid`, `1,234 rx`. */
export function portHealthParts(p: PortStat, num: (n: number, max?: number) => string): string[] {
  const parts: string[] = [];
  if (p.pps != null) parts.push(`${num(p.pps, 2)} pkt/s`);
  if (p.heard > 0) {
    parts.push(`${num(Math.floor((p.parsed / p.heard) * 100), 0)}% parsed`);
    parts.push(`${num(p.invalid, 0)} invalid`);
  }
  parts.push(`${num(p.rx, 0)} rx`);
  return parts;
}
