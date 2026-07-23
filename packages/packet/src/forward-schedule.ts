// SPDX-License-Identifier: MIT
/**
 * forward-schedule.ts — the pure scheduling decision for the FBB forwarding scheduler.
 * Given a partner's config (poll interval + optional UTC time-bands) and when it last ran, decide
 * whether a forwarding session is due now. No I/O, no clock — the ingest passes `nowSec`. Time-bands
 * are BPQ-style UTC hour windows ("0-6,22-23"); a window whose start > end wraps past midnight
 * ("22-6" = 22,23,0..6). An empty band list means "any time".
 */

export interface SchedulablePartner {
  enabled: boolean;
  intervalMin: number; // 0 ⇒ manual only (never auto-due)
  timebands: string; // "" ⇒ any time
}

/** Is the given UTC hour (0–23) inside any of the comma-separated `a-b` windows? Empty list ⇒ true. */
export function hourInBands(hour: number, timebands: string): boolean {
  const bands = timebands
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (bands.length === 0) return true;
  for (const band of bands) {
    const m = /^(\d{1,2})(?:-(\d{1,2}))?$/.exec(band);
    if (!m) continue;
    const lo = Number(m[1]) % 24;
    const hi = m[2] == null ? lo : Number(m[2]) % 24;
    const inBand = lo <= hi ? hour >= lo && hour <= hi : hour >= lo || hour <= hi; // wrap past midnight
    if (inBand) return true;
  }
  return false;
}

/**
 * Decide whether `partner` should forward now. Due when: enabled, interval > 0, the interval has
 * elapsed since `lastRunSec` (null ⇒ never run ⇒ due), and the current UTC hour is within its bands.
 */
export function partnerDue(partner: SchedulablePartner, lastRunSec: number | null, nowSec: number): boolean {
  if (!partner.enabled || partner.intervalMin <= 0) return false;
  if (lastRunSec != null && nowSec - lastRunSec < partner.intervalMin * 60) return false;
  const utcHour = new Date(nowSec * 1000).getUTCHours();
  return hourInBands(utcHour, partner.timebands);
}
