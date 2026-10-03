// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The instance's one on-air call. Radio commands (`FOUND`, `DNF`, `NOTE`, `HELP`) and `VERIFY` messages are
 * addressed to it; acks, replies and held personal mail are sent from it.
 *
 * It is a real callsign under the sysop's licence: the first `ADMIN_CALLSIGNS` base call with SSID 15, unless
 * `SERVICE_CALL` names another. A callsign shape is what every path accepts: MeshCom nodes drop a direct
 * message whose destination has no digit, and the APRS-IS uplink logs in under the service call's base call
 * and sends answers as plain messages, which IGates gate to RF. `APRSCG` is the fallback for an instance with
 * no sysop.
 */
import { baseCall } from "@aprscaching/aprs";
import type { Env } from "./env.js";

/** The SSID the default service call takes: "other" in the APRS SSID convention, valid in AX.25 and MeshCom. */
export const SERVICE_SSID = 15;
/** The service call of an instance with no sysop named. */
export const FALLBACK_SERVICE_CALL = "APRSCG";

/** The instance's service call, upper-cased. */
export function serviceCall(env: Env): string {
  const set = env.SERVICE_CALL?.trim();
  if (set) return set.toUpperCase();
  const sysop = (env.ADMIN_CALLSIGNS ?? "")
    .split(",")
    .map((c) => c.trim())
    .find(Boolean);
  if (!sysop) return FALLBACK_SERVICE_CALL;
  const base = baseCall(sysop.toUpperCase());
  // an AX.25 address holds six base characters; a longer base cannot carry an SSID on air
  return base.length <= 6 ? `${base}-${SERVICE_SSID}` : FALLBACK_SERVICE_CALL;
}
