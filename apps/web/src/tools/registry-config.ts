// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * registry-config.ts — where the Tools console finds the signed tool registry + the PINNED authority key it
 * verifies against. The registry is authority-signed; the app trusts ONLY this key, so a
 * forged/re-hosted registry is rejected. Point at your own registry + authority via Vite env at build time;
 * docs/contribute/tool-registry.md covers the file, the keys and running your own.
 */
export const TOOL_REGISTRY_URL: string = import.meta.env.VITE_TOOL_REGISTRY ?? "/tools/registry.json";

// The project's registry authority — the public half of the key apps/web/public/tools/registry.json is signed with.
// Rotate by generating a key (tools/toolkey/genkey.mjs), re-signing the registry, and updating this constant.
export const TOOL_REGISTRY_AUTHORITY: string =
  import.meta.env.VITE_TOOL_REGISTRY_AUTHORITY ?? "22usQMnB0VLUKlwA176NK2EZwqcSxcgx0M_rS2jNWp0";
