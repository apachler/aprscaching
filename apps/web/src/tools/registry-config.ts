/**
 * registry-config.ts — where the Tools console finds the signed tool registry + the PINNED authority key it
 * verifies against (docs/28 §7). The registry is authority-signed; the app trusts ONLY this key, so a
 * forged/re-hosted registry is rejected. Point at your own registry + authority via Vite env at build time.
 */
export const TOOL_REGISTRY_URL: string = import.meta.env.VITE_TOOL_REGISTRY ?? "/tools/registry.json";

// First-party (dev) registry authority — the public half of the key tools/toolkey/sign.mjs signed with.
// Rotate by regenerating (tools/toolkey/genkey.mjs), re-signing the registry, and updating this constant.
export const TOOL_REGISTRY_AUTHORITY: string =
  import.meta.env.VITE_TOOL_REGISTRY_AUTHORITY ?? "J12Zxjkj1-wbUYMgw9wEMfiNB85u4y6tyiQLfQaCink";
