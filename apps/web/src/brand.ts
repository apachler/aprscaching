// SPDX-License-Identifier: AGPL-3.0-or-later
/** The brand images the app serves. */
export const ASSET = {
  wordmark: "/brand/wordmark.png",
  beaconBlue: "/brand/beacon-blue.png",
  beaconGreen: "/brand/beacon-green.png",
  splash: "/brand/splash.png",
  bg: "/brand/bg.jpg",
} as const;

/** The published manual (the MkDocs site built from `docs/`): the one place the app's documentation lives. */
export const MANUAL_URL = "https://apachler.github.io/aprscaching/";

/**
 * A page of the published manual, by its path under `docs/` without `.md` (`"play/index"`,
 * `"reference/trust-model"`), and optionally a heading anchor on it. MkDocs serves a page at its directory URL.
 */
export function manualUrl(page = "index", anchor?: string): string {
  const dir = page.replace(/(^|\/)index$/, "");
  return `${MANUAL_URL}${dir ? `${dir}/` : ""}${anchor ? `#${anchor}` : ""}`;
}
