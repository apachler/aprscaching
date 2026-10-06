// SPDX-License-Identifier: AGPL-3.0-or-later
/** The words the Activity feed reads a log in: "OE3ABC didn't find AC-0004", "OE8APR wrote a note on AC-0002". */

const VERBS: Record<string, string> = {
  found: "found",
  dnf: "didn't find",
  note: "wrote a note on",
  maintenance: "did maintenance on",
  enabled: "enabled",
  disabled: "disabled",
};
const BADGES: Record<string, string> = {
  dnf: "DNF",
  note: "note",
  maintenance: "maintenance",
  enabled: "enabled",
  disabled: "disabled",
};

/** The verb between the logger and the cache; "logged" for a type this app does not know. */
export const activityVerb = (logType: string): string => VERBS[logType] ?? "logged";
/** The short badge a log that is not a find carries. */
export const activityBadge = (logType: string): string => BADGES[logType] ?? logType;
