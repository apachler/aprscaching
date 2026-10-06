// SPDX-License-Identifier: MIT
/**
 * Tool registries: the signed lists of tools the Shack's Tools app offers. A sysop configures the instance's
 * registries and a player may add their own; each entry pins the registry's authority key, which the browser
 * checks every signature against. This module holds what the gateway and the web app must agree on: the
 * project registry bundled with the app, how a registry address is written (an https URL or the
 * `github:owner/repo[/path][@ref]` shorthand) and checked, the shape of an authority key, and the
 * `TOOL_REGISTRIES` environment value.
 */

/** The project registry, bundled with every release and served by the instance itself. */
export const BUILTIN_TOOL_REGISTRY = {
  id: "builtin",
  spec: "/tools/registry.json",
  url: "/tools/registry.json",
  authority: "22usQMnB0VLUKlwA176NK2EZwqcSxcgx0M_rS2jNWp0",
  label: "APRScaching tools",
} as const;

/** The longest registry address accepted, as typed. */
export const REGISTRY_SPEC_MAX = 500;
/** The longest label. */
export const REGISTRY_LABEL_MAX = 60;
/** The registries one player may add. */
export const REGISTRIES_PER_ACCOUNT = 10;
/** The registries a sysop may add beside the project registry. */
export const INSTANCE_REGISTRIES_MAX = 20;

/** Who configured a registry: the sysop (`instance`) or the signed-in player (`account`). */
export type RegistryScope = "instance" | "account";

/** One configured registry, as the gateway serves it. */
export interface ToolRegistryEntry {
  id: string;
  scope: RegistryScope;
  /** The address as entered: an https URL, the github: shorthand, or the bundled registry's path. */
  spec: string;
  /** The address the registry is fetched from (spec expanded). */
  url: string;
  /** The pinned authority key, base64url Ed25519. */
  authority: string;
  label: string;
  enabled: boolean;
  /** The project registry bundled with the app. */
  builtin?: boolean;
}

const GH_OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const GH_REPO = /^[A-Za-z0-9._-]{1,100}$/;
const GH_PATH_SEGMENT = /^[A-Za-z0-9._~-]{1,100}$/;
const GH_REF = /^[A-Za-z0-9._/-]{1,100}$/;

/**
 * Expand `github:owner/repo[/path/to/registry.json][@ref]` to its raw.githubusercontent.com address. A missing
 * path is `registry.json`, a path not ending in `.json` names a folder holding one, and a missing ref is the
 * repository's default branch (`HEAD`).
 */
export function expandGithubShorthand(spec: string): { url: string } | { error: string } {
  const body = spec.slice("github:".length);
  const at = body.lastIndexOf("@");
  const where = at >= 0 ? body.slice(0, at) : body;
  const ref = at >= 0 ? body.slice(at + 1) : "HEAD";
  const parts = where.split("/");
  const [owner, repo, ...rest] = parts;
  if (!owner || !GH_OWNER.test(owner)) return { error: "github: needs an owner, as in github:owner/repo" };
  if (!repo || !GH_REPO.test(repo) || repo === "." || repo === "..")
    return { error: "github: needs a repository, as in github:owner/repo" };
  if (!GH_REF.test(ref) || ref.split("/").some((s) => s === "" || s === "." || s === ".."))
    return { error: "the @ref is not a branch, tag or commit name" };
  const path = rest.at(-1) === "" ? rest.slice(0, -1) : rest;
  if (path.some((s) => !GH_PATH_SEGMENT.test(s) || s === "." || s === ".."))
    return { error: "the path holds a character GitHub paths here may not" };
  const file =
    path.length === 0 ? ["registry.json"] : /\.json$/i.test(path.at(-1)!) ? path : [...path, "registry.json"];
  return { url: `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${file.join("/")}` };
}

/**
 * Check a registry address a sysop or player entered and return the URL it is fetched from: the github:
 * shorthand expanded, or an https URL with no user name or password in it. The fragment is dropped.
 */
export function registrySourceUrl(input: unknown): { spec: string; url: string } | { error: string } {
  if (typeof input !== "string" || input.trim() === "") return { error: "a registry address is required" };
  const spec = input.trim();
  if (spec.length > REGISTRY_SPEC_MAX)
    return { error: `a registry address is at most ${REGISTRY_SPEC_MAX} characters` };
  if (/[\s\u0000-\u001f\u007f]/.test(spec))
    return { error: "a registry address holds no spaces or control characters" };
  if (/^github:/i.test(spec)) {
    const r = expandGithubShorthand(`github:${spec.slice(7)}`);
    return "error" in r ? r : { spec: `github:${spec.slice(7)}`, url: r.url };
  }
  let u: URL;
  try {
    u = new URL(spec);
  } catch {
    return { error: "not an address: give an https:// URL or github:owner/repo" };
  }
  if (u.protocol !== "https:") return { error: "a registry address must use https://" };
  if (u.username || u.password) return { error: "a registry address carries no user name or password" };
  u.hash = "";
  return { spec, url: u.href };
}

/** An Ed25519 public key in base64url: 32 bytes, 43 characters without padding. */
export function isAuthorityKey(s: unknown): s is string {
  return typeof s === "string" && /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/.test(s);
}

/** A label: trimmed, one line, at most REGISTRY_LABEL_MAX characters; empty falls back to `fallback`. */
export function registryLabel(input: unknown, fallback: string): string {
  const s = typeof input === "string" ? input.replace(/[\u0000-\u001f\u007f]/g, " ").trim() : "";
  return (s || fallback).slice(0, REGISTRY_LABEL_MAX);
}

/** The label a registry gets when none is given: the GitHub owner/repo, else the host. */
export function defaultRegistryLabel(url: string): string {
  try {
    const u = new URL(url);
    if (u.hostname === "raw.githubusercontent.com") return u.pathname.split("/").slice(1, 3).join("/");
    return u.hostname;
  } catch {
    return url.slice(0, REGISTRY_LABEL_MAX);
  }
}

/**
 * Parse `TOOL_REGISTRIES`: a JSON array whose items are the string `"builtin"` (the bundled project registry)
 * or `{ "url", "authority", "label"?, "enabled"? }`, where `url` is an https URL, the github: shorthand, or a
 * path on this instance starting with `/`. The environment's list replaces the one stored in the database.
 */
export function parseToolRegistriesEnv(raw: string): { entries: ToolRegistryEntry[] } | { error: string } {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return { error: "TOOL_REGISTRIES is not JSON" };
  }
  if (!Array.isArray(v)) return { error: "TOOL_REGISTRIES must be a JSON array" };
  const entries: ToolRegistryEntry[] = [];
  for (const [i, item] of v.entries()) {
    if (item === "builtin") {
      entries.push({ ...BUILTIN_TOOL_REGISTRY, scope: "instance", enabled: true, builtin: true });
      continue;
    }
    if (!item || typeof item !== "object") return { error: `TOOL_REGISTRIES item ${i + 1} is not an object` };
    const o = item as Record<string, unknown>;
    const where =
      typeof o.url === "string" && /^\/(?!\/)/.test(o.url.trim())
        ? { spec: o.url.trim(), url: o.url.trim() }
        : registrySourceUrl(o.url);
    if ("error" in where) return { error: `TOOL_REGISTRIES item ${i + 1}: ${where.error}` };
    if (!isAuthorityKey(o.authority))
      return { error: `TOOL_REGISTRIES item ${i + 1}: authority must be a base64url Ed25519 public key` };
    entries.push({
      id: `env-${i + 1}`,
      scope: "instance",
      spec: where.spec,
      url: where.url,
      authority: o.authority,
      label: registryLabel(o.label, defaultRegistryLabel(where.url)),
      enabled: o.enabled !== false,
    });
  }
  return { entries };
}
