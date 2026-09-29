// SPDX-License-Identifier: MIT
/**
 * The base call of a callsign — the licence every SSID of it shares: uppercased, without the SSID and
 * without a trailing `*` (the has-been-digipeated mark on a path entry).
 */
export const baseCall = (c: string): string => c.trim().replace(/\*$/, "").toUpperCase().split("-")[0] ?? "";
