// SPDX-License-Identifier: MIT
/**
 * manifest.ts — a Tool's signed descriptor (`tool.json`). Kept dependency-free (no zod) so the package
 * stays MIT-clean + embeddable. A tool in process (a test, an embedding host) has no `entry`; a sandboxed tool
 * points `entry` at the script URL/file the sandbox loads.
 */
import { isCapability, type Capability } from "./capabilities.js";
import { isSurface, type Surface } from "./surfaces.js";
import { parseToolApi } from "./api.js";

export interface ToolManifest {
  name: string; // unique id, e.g. "cw-decoder"
  title: string; // human label
  author: string; // author callsign
  version: string;
  /** The tool API version the tool needs, `MAJOR.MINOR` (api.ts). Required to install; a tool in process omits it. */
  api?: string;
  permissions: Capability[]; // requested capabilities
  surfaces: Surface[]; // the tool's TYPE — which host surface(s) it plugs into (defaults to ["web"])
  remote?: boolean; // its /commands may be invoked by a REMOTE connected peer (PMS; D)
  description?: string;
  entry?: string; // the script URL/path the sandbox runs (a tool in process omits it)
  /** Imported tools: SHA-256 of the exact bytes `entry` serves, base64. Signed with the manifest, so a swapped
   *  script fails the check even though the manifest's signature still verifies. Required to import. */
  entrySha256?: string;
  connect?: string[]; // the https:/wss: origins a tool granted 'network' may reach — required with 'network'
  pubkey?: string; // author's raw Ed25519 public key (base64url) — the key `signature` verifies against
  signature?: string; // optional detached Ed25519 signature over the canonical manifest
}

const NAME_RE = /^[a-z0-9][a-z0-9-]{1,39}$/;
const MAX_CONNECT = 8;
/** 32 bytes in standard base64: 43 characters and one `=`. */
const SHA256_B64_RE = /^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=$/;

/** Normalise one `connect` entry to its origin; only https: and wss: origins with no path qualify. */
export function connectOrigin(x: unknown): string | null {
  if (typeof x !== "string") return null;
  let u: URL;
  try {
    u = new URL(x);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "wss:") return null;
  if (u.username || u.password || (u.pathname !== "/" && u.pathname !== "") || u.search || u.hash) return null;
  return `${u.protocol}//${u.host}`;
}

/** Validate an untrusted manifest object. Returns the normalised manifest or an error string. */
export function validateManifest(input: unknown): { ok: true; manifest: ToolManifest } | { ok: false; error: string } {
  if (typeof input !== "object" || input === null) return { ok: false, error: "manifest must be an object" };
  const m = input as Record<string, unknown>;
  if (typeof m.name !== "string" || !NAME_RE.test(m.name))
    return { ok: false, error: "invalid name (lowercase, 2–40 chars, [a-z0-9-])" };
  if (typeof m.title !== "string" || !m.title.trim()) return { ok: false, error: "title required" };
  if (typeof m.author !== "string" || !m.author.trim()) return { ok: false, error: "author (callsign) required" };
  if (typeof m.version !== "string" || !m.version.trim()) return { ok: false, error: "version required" };
  if (!parseToolApi(m.api))
    return { ok: false, error: 'api must name the tool API version the tool needs, as "MAJOR.MINOR"' };
  if (!Array.isArray(m.permissions) || !m.permissions.every(isCapability))
    return { ok: false, error: "permissions must be a list of known capabilities" };
  if (m.surfaces !== undefined && (!Array.isArray(m.surfaces) || !m.surfaces.every(isSurface)))
    return { ok: false, error: "surfaces must be a list of known surfaces (web/terminal/bbs/node/map)" };
  if (m.entry !== undefined && typeof m.entry !== "string")
    return { ok: false, error: "entry must be a string URL/path" };
  if (m.entrySha256 !== undefined && (typeof m.entrySha256 !== "string" || !SHA256_B64_RE.test(m.entrySha256)))
    return { ok: false, error: "entrySha256 must be the base64 SHA-256 of the entry script" };
  if (m.pubkey !== undefined && typeof m.pubkey !== "string")
    return { ok: false, error: "pubkey must be a base64url string" };
  let connect: string[] | undefined;
  if (m.connect !== undefined) {
    if (!Array.isArray(m.connect) || m.connect.length > MAX_CONNECT)
      return { ok: false, error: `connect must be a list of at most ${MAX_CONNECT} origins` };
    const origins = m.connect.map(connectOrigin);
    if (origins.some((o) => o === null))
      return { ok: false, error: "connect entries must be https:// or wss:// origins, without a path" };
    connect = [...new Set(origins as string[])];
  }
  if ((m.permissions as unknown[]).includes("network") && !connect?.length)
    return { ok: false, error: "a tool asking for network lists the origins it reaches in connect" };
  const surfaces = Array.isArray(m.surfaces) && m.surfaces.length ? [...new Set(m.surfaces)] : (["web"] as Surface[]);
  return {
    ok: true,
    manifest: {
      name: m.name,
      title: m.title.trim(),
      author: m.author.trim().toUpperCase(),
      version: m.version.trim(),
      api: m.api as string,
      permissions: [...new Set(m.permissions)],
      surfaces,
      remote: m.remote === true || undefined,
      description: typeof m.description === "string" ? m.description : undefined,
      entry: typeof m.entry === "string" ? m.entry : undefined,
      entrySha256: typeof m.entrySha256 === "string" ? m.entrySha256 : undefined,
      connect,
      pubkey: typeof m.pubkey === "string" ? m.pubkey : undefined,
      signature: typeof m.signature === "string" ? m.signature : undefined,
    },
  };
}
