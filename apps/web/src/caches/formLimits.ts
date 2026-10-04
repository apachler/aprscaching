// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The cache and log forms check their text against the limits the gateway's schemas hold (TEXT_LIMITS), and word a
 * refusal the gateway still sends as the field it is about.
 */
import { TEXT_LIMITS } from "@aprscaching/shared";
import { ApiError, errorText } from "../api.js";

/** The tags typed as a comma list, trimmed, at most as many as a cache takes. */
export const parseTags = (text: string): string[] =>
  text
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean)
    .slice(0, TEXT_LIMITS.tags);

/** The first tag that is too long, as a message, or null. */
export function tagProblem(tags: string[]): string | null {
  const long = tags.find((t) => t.length > TEXT_LIMITS.tag);
  return long ? `The tag “${long.slice(0, 12)}…” is longer than ${TEXT_LIMITS.tag} characters.` : null;
}

const FIELD: Record<string, string> = {
  title: "Title",
  hint: "Hint",
  description: "Description",
  tags: "Tags",
  comment: "Comment",
  lat: "Position",
  lon: "Position",
  difficulty: "Difficulty",
  terrain: "Terrain",
  stationCall: "Station",
  country: "Country",
};

/**
 * What a refused request says, for the form: a schema refusal (`issues`) names the field it is about and its limit;
 * anything else is the server's own message.
 */
export function refusalMessage(e: unknown): string {
  if (e instanceof ApiError) {
    const issue = (e.data as { issues?: SchemaIssue[] } | null)?.issues?.[0];
    if (issue) {
      const key = String(issue.path?.[0] ?? "");
      const field = FIELD[key] ?? "A field";
      if (issue.code === "too_big" && typeof issue.maximum === "number") {
        if (key === "tags")
          return issue.origin === "array"
            ? `Tags: at most ${issue.maximum}.`
            : `Tags: each is at most ${issue.maximum} characters.`;
        if (issue.origin === "string") return `${field}: at most ${issue.maximum} characters.`;
      }
      return `${field}: ${issue.message ?? "not accepted"}.`;
    }
  }
  return errorText(e);
}

/** One schema issue as the gateway sends it (zod). */
interface SchemaIssue {
  path?: (string | number)[];
  code?: string;
  origin?: string;
  maximum?: number;
  message?: string;
}
