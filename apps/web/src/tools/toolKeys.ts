// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * toolKeys.ts — the trust-on-first-use pins of tools installed outside a registry: the manifest's address → the key
 * that signed it when the user approved it. A pin follows the address, never the `author` a manifest names, because
 * a self-signed manifest can name any callsign: a pin under a name would let one tool decide trust for every other
 * tool that names the same author. A later manifest at the same address signed by another key is refused. The pins
 * belong to the identity that approved them, so they are cleared with its installs (`toolOwner.ts`).
 */
import { resolveTrust, type ManifestSig, type ToolTrust } from "@aprscaching/tools";

export const TOOL_KEYS_KEY = "acs.tool.keys";

function pins(): Record<string, string> {
  try {
    const m = JSON.parse(localStorage.getItem(TOOL_KEYS_KEY) || "{}") as unknown;
    return m && typeof m === "object" && !Array.isArray(m) ? (m as Record<string, string>) : {};
  } catch {
    return {};
  }
}

/** The key the user trusted for the manifest at `url`, if any. */
export function pinnedKey(url: string): string | undefined {
  const k = pins()[url];
  return typeof k === "string" ? k : undefined;
}

/** Trust `pubkey` for the manifest at `url` from now on. */
export function pinKey(url: string, pubkey: string): void {
  try {
    const m = pins();
    m[url] = pubkey;
    localStorage.setItem(TOOL_KEYS_KEY, JSON.stringify(m));
  } catch {
    /* storage blocked: the pin lasts for this approval only */
  }
}

/** The identity of a self-signed tool: the first 16 characters of its key, in groups of four. */
export function keyFingerprint(pubkey: string): string {
  return (pubkey.slice(0, 16).match(/.{1,4}/g) ?? []).join(" ");
}

/**
 * The trust of a manifest fetched from `url`: the registry's listed key when one lists it there, else the key pinned
 * for that address. The `author` the manifest names takes no part.
 */
export function toolTrust(
  sig: ManifestSig,
  url: string,
  manifest: { author: string; pubkey?: string },
  registryPubkey?: string,
): ToolTrust {
  return resolveTrust(sig, { registryPubkey, pinnedPubkey: pinnedKey(url), pubkey: manifest.pubkey });
}
