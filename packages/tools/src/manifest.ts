/**
 * manifest.ts — a Tool's signed descriptor (`tool.json`). Kept dependency-free (no zod) so the package
 * stays MIT-clean + embeddable. A built-in tool has no `entry`; an imported tool points `entry` at a
 * JS module URL/file the sandbox loads.
 */
import { isCapability, type Capability } from "./capabilities.js";

export interface ToolManifest {
  name: string;              // unique id, e.g. "cw-decoder"
  title: string;             // human label
  author: string;            // author callsign
  version: string;
  permissions: Capability[]; // requested capabilities
  description?: string;
  entry?: string;            // imported tools: the script URL/path the sandbox runs (built-ins omit it)
  signature?: string;        // optional detached signature over the manifest (author key)
}

const NAME_RE = /^[a-z0-9][a-z0-9-]{1,39}$/;

/** Validate an untrusted manifest object. Returns the normalised manifest or an error string. */
export function validateManifest(input: unknown): { ok: true; manifest: ToolManifest } | { ok: false; error: string } {
  if (typeof input !== "object" || input === null) return { ok: false, error: "manifest must be an object" };
  const m = input as Record<string, unknown>;
  if (typeof m.name !== "string" || !NAME_RE.test(m.name)) return { ok: false, error: "invalid name (lowercase, 2–40 chars, [a-z0-9-])" };
  if (typeof m.title !== "string" || !m.title.trim()) return { ok: false, error: "title required" };
  if (typeof m.author !== "string" || !m.author.trim()) return { ok: false, error: "author (callsign) required" };
  if (typeof m.version !== "string" || !m.version.trim()) return { ok: false, error: "version required" };
  if (!Array.isArray(m.permissions) || !m.permissions.every(isCapability)) return { ok: false, error: "permissions must be a list of known capabilities" };
  if (m.entry !== undefined && typeof m.entry !== "string") return { ok: false, error: "entry must be a string URL/path" };
  return {
    ok: true,
    manifest: {
      name: m.name, title: m.title.trim(), author: m.author.trim().toUpperCase(), version: m.version.trim(),
      permissions: [...new Set(m.permissions as Capability[])],
      description: typeof m.description === "string" ? m.description : undefined,
      entry: typeof m.entry === "string" ? m.entry : undefined,
      signature: typeof m.signature === "string" ? m.signature : undefined,
    },
  };
}
