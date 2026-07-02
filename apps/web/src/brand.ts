// SPDX-License-Identifier: AGPL-3.0-or-later
/** APRScaching brand palette (from the original 2016 identity, colors.txt). */
export const BRAND = {
  blue: "#2D8BAB",   // primary / chrome
  green: "#7BB912",  // accent / "found"
  greenDark: "#5a8a0e", // deeper nature green (WWFF flora/fauna reserve)
  grey: "#4B4F51",   // ink / muted-strong
  beige: "#B57D5D",
  beige2: "#C3934A",
} as const;

/** Colours consumed by MapLibre markers/paint. MapLibre writes these into SVG fill attributes and
 *  can't read CSS custom properties (same constraint as the map style JSON), so they live here as the
 *  single JS-side source rather than as literals scattered through components. */
export const MAP_MARKER = {
  draft: "#e53e3e",  // transient "placing a new cache" pin — attention red (mirrors the --bad token)
} as const;

export const ASSET = {
  wordmark: "/brand/wordmark.png",
  beaconBlue: "/brand/beacon-blue.png",
  beaconGreen: "/brand/beacon-green.png",
  splash: "/brand/splash.png",
  bg: "/brand/bg.jpg",
} as const;
