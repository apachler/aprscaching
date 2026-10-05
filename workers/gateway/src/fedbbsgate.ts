// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * fedbbsgate.ts — who federation over FBB may travel with. It is experimental and off unless `FED_BBS` is on,
 * and then only with the forwarding partners the sysop marks for it (`bbs_partners.federation`). A leaf module:
 * the forwarding pool, the inbound path, the enqueue and the relay all ask it, and none of them depend on each
 * other through it.
 */
import { flagOn, type Env } from "./env.js";
import { baseCall } from "@aprscaching/aprs";

/** Is federation over FBB on? Off by default: it spends partner BBSes' bandwidth on machine data. */
export const fedBbsOn = (env: Env): boolean => flagOn(env.FED_BBS);

/** What a sender or a dispatcher is told while `FED_BBS` is off. */
export const FED_BBS_OFF = "federation over FBB is off on this instance — set FED_BBS=1 to use it";

/**
 * The forwarding partner marked for federation that `call` names, or null. The scheduler that dials a partner
 * reports the partner row's call; the BBS that answers a partner's dial-in knows only the caller's AX.25 call,
 * which may carry another SSID — so an exact match wins, else a partner row on the same base call.
 */
export async function federationPartner(env: Env, call: string): Promise<{ call: string; ha: string | null } | null> {
  const c = call.trim().toUpperCase();
  if (!c) return null;
  const rows = (
    await env.DB.prepare("SELECT call, ha FROM bbs_partners WHERE federation = 1").all<{
      call: string;
      ha: string | null;
    }>()
  ).results;
  return (
    rows.find((r) => r.call.toUpperCase() === c) ??
    rows.find((r) => baseCall(r.call.toUpperCase()) === baseCall(c)) ??
    null
  );
}
