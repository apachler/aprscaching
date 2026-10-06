// SPDX-License-Identifier: MIT
/**
 * api.ts — the tool API version: what the sandbox offers a tool, versioned apart from the app's own releases. A
 * tool's manifest names the version it needs (`"api": "MAJOR.MINOR"`). A change that only adds (a new capability, a
 * new method, a new event) raises the minor; a change that breaks a tool written for the old API raises the major.
 * The app runs a tool whose major equals its own and whose minor is no higher.
 */

/** The tool API this package's host and the app's sandbox implement. */
export const TOOL_API = { major: 1, minor: 0 } as const;
export const TOOL_API_VERSION = `${TOOL_API.major}.${TOOL_API.minor}`;

const API_RE = /^(0|[1-9][0-9]{0,3})\.(0|[1-9][0-9]{0,3})$/;

/** A manifest's `api` as numbers, or null when it is missing or not `MAJOR.MINOR`. */
export function parseToolApi(x: unknown): { major: number; minor: number } | null {
  const m = typeof x === "string" ? API_RE.exec(x) : null;
  return m ? { major: Number(m[1]), minor: Number(m[2]) } : null;
}

/** Why an app implementing `impl` cannot run a tool that needs `api`, or null when it can. */
export function toolApiProblem(api: unknown, impl: { major: number; minor: number } = TOOL_API): string | null {
  const v = parseToolApi(api);
  if (!v) return 'the manifest names no tool API version ("api": "MAJOR.MINOR")';
  if (v.major !== impl.major || v.minor > impl.minor)
    return `it needs tool API ${v.major}.${v.minor}; this instance implements ${impl.major}.${impl.minor}`;
  return null;
}
