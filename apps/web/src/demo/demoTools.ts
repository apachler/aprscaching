// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Demo tools — the design harness and the fixture app install project tools from the registry bundled with the
 * app (`/tools/registry.json`), the way a player does from the Tools app, so a surface shows them running. The
 * registry's signature is checked against the pinned key, and the install checks each tool's code against its
 * signed hash; a tool the bundled registry does not list is skipped.
 */
import { BUILTIN_TOOL_REGISTRY } from "@aprscaching/shared";
import { checkPinnedRegistry, type SignedRegistry } from "@aprscaching/tools";
import { installTool } from "../tools/installed.js";
import { fetchToolManifest } from "../tools/sandbox.js";
import { DIRECT, registryUrl } from "../tools/registries.js";

export async function installDemoTools(names: readonly string[]): Promise<void> {
  const url = registryUrl(BUILTIN_TOOL_REGISTRY, location.href);
  const doc = await fetch(url)
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null);
  if ((await checkPinnedRegistry(doc, BUILTIN_TOOL_REGISTRY.authority)) !== "ok") return;
  for (const name of names) {
    const entry = (doc as SignedRegistry).entries.find((e) => e.name === name);
    if (!entry) continue;
    const r = await fetchToolManifest(new URL(entry.entry, url).href);
    if (r.ok && r.manifest.pubkey === entry.pubkey)
      await installTool({ manifest: r.manifest, base: r.base, carrier: DIRECT });
  }
}
