// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Whether the map can draw here, and what the app shows without it. MapLibre draws with WebGL2 and
 * throws while it is created when the browser refuses the context — which privacy-hardened browsers
 * do by default — so the map probes first and the rest of the app works from a bounding box instead.
 */

/** The notice shown in place of a map the browser cannot draw. */
export const NO_WEBGL_TEXT =
  "This browser has WebGL turned off, so the map can't draw. Enable WebGL for this site, or use the Nearby list.";

type CanvasLike = { getContext(kind: string): unknown };

/** True when a WebGL2 context can be created (the probe canvas is thrown away). */
export function canDrawMap(
  makeCanvas: () => CanvasLike = () => document.createElement("canvas") as unknown as CanvasLike,
): boolean {
  try {
    return !!makeCanvas().getContext("webgl2");
  } catch {
    return false;
  }
}

/**
 * The area the app loads caches for when there is no map to read it from: about 1.5° × 1° around the
 * position in MapLibre's `#zoom/lat/lon` hash, or around `center` ([lon, lat]).
 */
export function fallbackBbox(hash: string, center: [number, number]): [number, number, number, number] {
  const [, lat, lon] = hash.replace(/^#/, "").split("/").map(Number);
  const ok = lat != null && lon != null && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
  const [x, y] = ok ? [lon, lat] : center;
  return [x - 0.75, y - 0.5, x + 0.75, y + 0.5];
}
