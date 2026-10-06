// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Demo tools — the design harness and the fixture app install project tools from the registry bundled with the
 * app (`/tools/registry.json`), the way a player does from the Tools app, so a surface shows them running. The
 * registry's signature is checked against the pinned key, and the install checks each tool's code against its
 * signed hash; a tool the bundled registry does not list is skipped. The installs last for the page only: they are
 * never stored or synced to an account, and only a development build or an automated browser (the visual and
 * accessibility harness) takes them.
 */

/** Demo installs run without a prompt, so only where no person is asked: a development build or a driven browser. */
const demoToolsAllowed = (): boolean => import.meta.env.DEV || navigator.webdriver === true;
import { BUILTIN_TOOL_REGISTRY } from "@aprscaching/shared";
import { checkPinnedRegistry, type SignedRegistry } from "@aprscaching/tools";
import { installTool } from "../tools/installed.js";
import { toolOwner } from "../tools/toolOwner.js";
import { fetchToolManifest } from "../tools/sandbox.js";
import { DIRECT, registryUrl } from "../tools/registries.js";

/**
 * Install `names` from the bundled registry for this page. In the app, `afterSession` waits until the session is
 * known and the installs are claimed for it, which would otherwise stop these page-only ones again.
 */
export async function installDemoTools(names: readonly string[], afterSession = false): Promise<void> {
  if (!demoToolsAllowed()) return;
  for (let i = 0; afterSession && toolOwner() === null && i < 200; i++) await new Promise((r) => setTimeout(r, 50));
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
      await installTool({ manifest: r.manifest, base: r.base, carrier: DIRECT, persist: false });
  }
}
