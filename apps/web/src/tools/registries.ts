// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * registries.ts — the tool registries the Tools app lists, loaded and checked in the browser. The gateway says
 * which registries there are (toolregistries.ts) and, when it carries them, serves their files from this
 * instance; the browser decides trust alone: each registry file must verify under the key pinned for it, and a
 * file naming another key is held back as "key changed" until the person who added it confirms the new key.
 *
 * Addresses stay upstream addresses throughout: an entry's relative `entry` resolves against the registry's own
 * URL, and a manifest's script against the manifest's URL, as the publisher wrote them. A carried registry only
 * changes where the bytes are fetched from (`carrier`), never the address they are judged by.
 */
import { BUILTIN_TOOL_REGISTRY, type ToolRegistryEntry } from "@aprscaching/shared";
import {
  authorityFingerprint,
  checkEntryHash,
  checkPinnedRegistry,
  previewRegistry,
  registryEntryFor,
  type RegistryEntry,
  type RegistryPreview,
  type SignedRegistry,
} from "@aprscaching/tools";
import type { EffectiveToolRegistry } from "../api.js";

/** How the browser fetches a file it knows by its upstream address. */
export interface Carrier {
  /** The URL the bytes are fetched from. */
  fetchUrl(upstream: string): string;
  init: RequestInit;
}

/** Fetch straight from the publisher, without cookies. */
export const DIRECT: Carrier = { fetchUrl: (u) => u, init: { credentials: "omit" } };

/** The carrier for a registry: through this instance when the gateway carries it, else direct. */
export function carrierFor(reg: EffectiveToolRegistry, apiBase: string): Carrier {
  if (!reg.proxied) return DIRECT;
  return {
    fetchUrl: (u) => `${apiBase}/api/tools/registries/${encodeURIComponent(reg.id)}/file?url=${encodeURIComponent(u)}`,
    // a player's own registry is carried for that player alone, so the session goes along to this instance
    init: { credentials: reg.scope === "account" ? "include" : "omit" },
  };
}

/** A registry's own address, absolute: a path on this instance resolves against the page. */
export const registryUrl = (reg: Pick<ToolRegistryEntry, "url">, pageHref: string): string =>
  new URL(reg.url, pageHref).href;

/** Where one registry stands in the Tools app. */
export type RegistryState =
  | { kind: "loading" }
  | { kind: "ok"; entries: RegistryEntry[]; stale: boolean }
  | { kind: "none" }
  | { kind: "failed"; error: string }
  | { kind: "invalid" }
  | { kind: "key-changed"; authority: string; fingerprint: string | null };

export interface LoadedRegistry {
  reg: EffectiveToolRegistry;
  /** The pinned key's fingerprint. */
  fingerprint: string | null;
  state: RegistryState;
}

/** Fetch one registry through its carrier and check it against its pinned key. Never throws. */
export async function loadRegistry(
  reg: EffectiveToolRegistry,
  apiBase: string,
  pageHref: string,
  fetchImpl: typeof fetch = fetch,
): Promise<RegistryState> {
  const carrier = carrierFor(reg, apiBase);
  let res: Response;
  try {
    res = await fetchImpl(carrier.fetchUrl(registryUrl(reg, pageHref)), carrier.init);
  } catch (e) {
    return { kind: "failed", error: (e as Error).message || "the registry can't be reached" };
  }
  if (res.status === 404 && reg.builtin) return { kind: "none" };
  if (!res.ok) {
    const why = (await res.json().catch(() => null)) as { error?: string } | null;
    return { kind: "failed", error: why?.error ?? `the registry answered ${res.status}` };
  }
  let doc: unknown;
  try {
    doc = await res.json();
  } catch {
    return { kind: "invalid" };
  }
  const state = await checkPinnedRegistry(doc, reg.authority);
  if (state === "key-changed") {
    const authority = String((doc as SignedRegistry).authority);
    return { kind: "key-changed", authority, fingerprint: await authorityFingerprint(authority) };
  }
  if (state === "invalid") return { kind: "invalid" };
  return {
    kind: "ok",
    entries: (doc as SignedRegistry).entries,
    stale: res.headers.get("x-tool-registry-copy") === "stale",
  };
}

/** A listed tool, shown once however many registries list it. */
export interface Listing {
  entry: RegistryEntry;
  /** The manifest's upstream address. */
  manifestUrl: string;
  /** The registry the import uses, the first that lists the tool. */
  from: LoadedRegistry;
  /** The labels of every registry that lists it. */
  sources: string[];
}

/**
 * The tools of every loaded registry, grouped by registry in list order: a tool listed by several registries (the
 * same name, manifest address and author key) shows once, under the first, with each registry that lists it.
 */
export function groupListings(
  loaded: LoadedRegistry[],
  pageHref: string,
): { reg: LoadedRegistry; listings: Listing[] }[] {
  const seen = new Map<string, Listing>();
  const groups: { reg: LoadedRegistry; listings: Listing[] }[] = [];
  for (const l of loaded) {
    const listings: Listing[] = [];
    if (l.state.kind === "ok") {
      const base = registryUrl(l.reg, pageHref);
      for (const entry of l.state.entries) {
        let manifestUrl: string;
        try {
          manifestUrl = new URL(entry.entry, base).href;
        } catch {
          continue;
        }
        const key = `${entry.name}\n${manifestUrl}\n${entry.pubkey}`;
        const first = seen.get(key);
        if (first) {
          if (!first.sources.includes(l.reg.label)) first.sources.push(l.reg.label);
          continue;
        }
        const listing = { entry, manifestUrl, from: l, sources: [l.reg.label] };
        seen.set(key, listing);
        listings.push(listing);
      }
    }
    groups.push({ reg: l, listings });
  }
  return groups;
}

/** The registry that lists the manifest fetched from `manifestUrl`, and its entry; the instance's come first. */
export function listingFor(
  loaded: LoadedRegistry[],
  name: string,
  manifestUrl: string,
  pageHref: string,
): { entry: RegistryEntry; from: LoadedRegistry } | undefined {
  for (const l of loaded) {
    if (l.state.kind !== "ok") continue;
    const entry = registryEntryFor(l.state.entries, name, manifestUrl, registryUrl(l.reg, pageHref));
    if (entry) return { entry, from: l };
  }
  return undefined;
}

/** Why a tool's code is refused, in the words the app shows. */
export const CODE_MISMATCH = "the tool's code does not match its signed manifest";

/**
 * Fetch a tool's script and check its bytes against the manifest's signed `entrySha256`. The text the sandbox runs,
 * or an error naming why it may not run.
 */
export async function fetchToolScript(
  manifest: { entrySha256?: string },
  scriptUrl: string,
  carrier: Carrier = DIRECT,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: true; script: string } | { ok: false; error: string }> {
  let bytes: Uint8Array;
  try {
    const res = await fetchImpl(carrier.fetchUrl(scriptUrl), carrier.init);
    if (!res.ok) return { ok: false, error: `the tool's code answered ${res.status}` };
    bytes = new Uint8Array(await res.arrayBuffer());
  } catch (e) {
    return { ok: false, error: `the tool's code can't be fetched: ${(e as Error).message}` };
  }
  const check = await checkEntryHash(manifest, bytes);
  if (check === "missing") return { ok: false, error: "the manifest pins no hash of its code (entrySha256)" };
  if (check === "mismatch") return { ok: false, error: CODE_MISMATCH };
  return { ok: true, script: new TextDecoder().decode(bytes) };
}

/** The bundled project registry as the list shows it when the gateway can't be asked. */
export const BUILTIN_FALLBACK: EffectiveToolRegistry = {
  ...BUILTIN_TOOL_REGISTRY,
  scope: "instance",
  enabled: true,
  builtin: true,
  proxied: false,
};

/**
 * Look at a registry before adding it: fetched through this instance's preview while it carries registries,
 * else straight from the publisher; then checked to be intact under the key it names. The key is not trusted
 * here: the person compares the fingerprint with the publisher's and confirms it.
 */
export async function previewRegistrySource(
  spec: string,
  url: string,
  proxy: boolean,
  apiBase: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: true; preview: RegistryPreview } | { ok: false; error: string }> {
  let res: Response;
  try {
    res = proxy
      ? await fetchImpl(`${apiBase}/api/tools/registries/preview?spec=${encodeURIComponent(spec)}`, {
          credentials: "include",
        })
      : await fetchImpl(url, { credentials: "omit" });
  } catch (e) {
    return { ok: false, error: `couldn't fetch the registry: ${(e as Error).message}` };
  }
  if (!res.ok) {
    const why = (await res.json().catch(() => null)) as { error?: string } | null;
    return { ok: false, error: why?.error ?? `the registry answered ${res.status}` };
  }
  const doc = await res.json().catch(() => null);
  return previewRegistry(doc);
}
