// SPDX-License-Identifier: AGPL-3.0-or-later
/** A JSON-valued setting: the parsed value, or `undefined` when it is unset or not valid JSON. */
export function jsonSetting(raw: string | undefined): unknown {
  if (raw == null || raw.trim() === "") return undefined;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

/** A JSON object setting, or `{}` when it is unset, malformed or not an object. */
export function jsonObjectSetting(raw: string | undefined): Record<string, unknown> {
  const v = jsonSetting(raw);
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}
