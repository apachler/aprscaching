// SPDX-License-Identifier: AGPL-3.0-or-later
/** Why a stage did not unlock, as the finder reads it. `distance` is the formatted distance for `too_far`. */
export function stageRefusalText(reason: string | undefined, distance?: string): string {
  switch (reason) {
    case "needs_connection":
      return "This stage unlocks online: the instance checks it. Try again with a connection.";
    case "too_far":
      return distance ? `Too far — ${distance} away.` : "Too far from the stage before.";
    case "bad_code":
      return "That tag/code doesn't match this stage.";
    case "no_code":
      return "Scan the NFC tag or enter its code.";
    case "no_geo":
      return "This stage needs your location: allow it and try again.";
    case "no_tag":
      return "The owner has not set this stage's tag yet.";
    case "limited":
      return "Too many tries on this tag — try again in an hour.";
    case "previous_stage":
      return "Reach the stage before first.";
    default:
      return "Not unlocked yet.";
  }
}
