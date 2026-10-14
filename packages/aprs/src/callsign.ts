// SPDX-License-Identifier: MIT
/**
 * The base call of a callsign — the licence every SSID of it shares: uppercased, without the SSID and
 * without a trailing `*` (the has-been-digipeated mark on a path entry).
 */
export const baseCall = (c: string): string => c.trim().replace(/\*$/, "").toUpperCase().split("-")[0] ?? "";

/**
 * The same station: callsign and SSID equal, `-0` the same as none, any `*` mark ignored. Another SSID of
 * one base call is another station (the operator's handheld, their car), so it is gated and repeated like
 * anyone else's.
 */
export const sameStation = (a: string, b: string): boolean => {
  const norm = (c: string) => c.trim().replace(/\*$/, "").toUpperCase().replace(/-0$/, "");
  return norm(a) === norm(b);
};
