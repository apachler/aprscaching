// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The APRS message that logs a queued log from a radio, for when the phone has no data but a handheld
 * reaches an IGate or the instance's receiver: `FOUND AC-1234 text`, `DNF AC-1234 text` or
 * `NOTE AC-1234 text`, sent to the instance's service call (the radio log commands, radiolog.ts). An
 * APRS message carries at most 67 characters. A find sent this way is scored by the radio path's own trust
 * rules, not by the app's signed reading.
 */
import type { QueuedLog } from "./logQueue.js";

/** The longest APRS message text. */
export const APRS_MESSAGE_MAX = 67;

const WORDS: Record<string, string> = { found: "FOUND", dnf: "DNF", note: "NOTE" };

/** The message for a queued log, or null when the radio cannot log it (another kind, no code, a note without text). */
export function radioLogText(item: QueuedLog<{ logType: string; comment?: string }>): string | null {
  const word = WORDS[item.body.logType];
  const code = item.label?.trim();
  if (!word || !code || item.kind === "unlock") return null;
  const text = item.body.comment?.replace(/\s+/g, " ").trim() ?? "";
  if (word === "NOTE" && !text) return null;
  return `${word} ${code}${text ? ` ${text}` : ""}`.slice(0, APRS_MESSAGE_MAX);
}
