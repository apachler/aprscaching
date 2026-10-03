// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Where the phone points: the compass heading the browser's orientation events give, and the direction of
 * travel GPS readings give when there is no compass. Pure logic plus one subscription over `window`.
 *
 * Chromium on Android sends `deviceorientationabsolute`, whose `alpha` turns counter-clockwise from north;
 * Safari on iOS sends `deviceorientation` with its own `webkitCompassHeading`, clockwise from north, and
 * `webkitCompassAccuracy`, and asks the user first (`DeviceOrientationEvent.requestPermission`, which must
 * run from a tap). A plain `deviceorientation` without either is relative to how the page started, not to
 * north, and is ignored. Both readings follow the top of the device, so the screen's rotation is added.
 */
import { bearingDeg, haversine } from "../map/geo.js";

/** The fields of an orientation event this module reads. */
export interface OrientationReading {
  alpha: number | null;
  absolute?: boolean;
  webkitCompassHeading?: number;
  webkitCompassAccuracy?: number;
}

/** A compass heading in degrees clockwise from north, and its accuracy in degrees when the browser gives one. */
export interface Heading {
  deg: number;
  /** Plus or minus this many degrees; negative or absent when the browser cannot say. */
  accuracyDeg: number | null;
}

const norm = (d: number) => ((d % 360) + 360) % 360;

/** The heading an orientation event gives, with the screen turned `screenAngle` degrees; null when it gives none. */
export function headingFromOrientation(e: OrientationReading, screenAngle: number): Heading | null {
  if (typeof e.webkitCompassHeading === "number" && Number.isFinite(e.webkitCompassHeading))
    return { deg: norm(e.webkitCompassHeading + screenAngle), accuracyDeg: e.webkitCompassAccuracy ?? null };
  if (e.absolute && e.alpha != null && Number.isFinite(e.alpha))
    return { deg: norm(360 - e.alpha + screenAngle), accuracyDeg: null };
  return null;
}

/** The signed turn from `from` to `to`, in degrees within (-180, 180]. Pure. */
export function turn(from: number, to: number): number {
  const d = norm(to - from);
  return d > 180 ? d - 360 : d;
}

/** Ease `prev` toward `next` by `k` along the short way round, so the needle does not swing through 0°. Pure. */
export function smoothAngle(prev: number | null, next: number, k = 0.3): number {
  return prev == null ? norm(next) : norm(prev + k * turn(prev, next));
}

/** A compass is badly calibrated when the browser says it is off by more than this, or cannot say. */
export const CALIBRATE_ABOVE_DEG = 25;
export const needsCalibration = (h: Heading): boolean =>
  h.accuracyDeg != null && (h.accuracyDeg < 0 || h.accuracyDeg > CALIBRATE_ABOVE_DEG);

/**
 * The direction of travel from GPS readings: the bearing from the last place it was taken to the current one,
 * once the walker has moved further than the two readings' uncertainty (and at least `minM`). Feed it every
 * reading; it returns the course, which holds between updates.
 */
export function courseTracker(minM = 8) {
  let anchor: { lat: number; lon: number; acc: number } | null = null;
  let course: number | null = null;
  return (lat: number, lon: number, accuracyM: number): number | null => {
    if (!anchor) {
      anchor = { lat, lon, acc: accuracyM };
      return course;
    }
    const moved = haversine(anchor.lat, anchor.lon, lat, lon);
    if (moved >= Math.max(minM, (anchor.acc + accuracyM) / 2)) {
      course = bearingDeg(anchor.lat, anchor.lon, lat, lon);
      anchor = { lat, lon, acc: accuracyM };
    }
    return course;
  };
}

/** Within this distance of the pin, or of the reading's own accuracy if larger, the needle hands over to the eye. */
export const SEARCH_HERE_M = 10;
export const atThePin = (distM: number, accuracyM: number): boolean => distM <= Math.max(SEARCH_HERE_M, accuracyM);

type PermissionFn = () => Promise<"granted" | "denied" | "default">;
const permissionFn = (): PermissionFn | null => {
  const D = (globalThis as { DeviceOrientationEvent?: { requestPermission?: PermissionFn } }).DeviceOrientationEvent;
  return typeof D?.requestPermission === "function" ? D.requestPermission.bind(D) : null;
};

/** Whether the browser asks before it gives orientation (Safari on iOS); the request must come from a tap. */
export const compassNeedsPermission = (): boolean => permissionFn() != null;

/** Ask for orientation where the browser asks first. Call it from a tap. */
export async function requestCompass(): Promise<boolean> {
  const ask = permissionFn();
  if (!ask) return true;
  try {
    return (await ask()) === "granted";
  } catch {
    return false;
  }
}

/**
 * Watch the compass. `onHeading` gets each reading; `onNone` fires once when no heading has come within
 * `waitMs` (a phone or computer without a compass sensor). Returns the stop function.
 */
export function watchHeading(opts: {
  onHeading: (h: Heading) => void;
  onNone: () => void;
  waitMs?: number;
}): () => void {
  if (typeof window === "undefined") {
    opts.onNone();
    return () => {};
  }
  const type = "ondeviceorientationabsolute" in window ? "deviceorientationabsolute" : "deviceorientation";
  let got = false;
  const listener = (ev: Event) => {
    const angle = screen.orientation?.angle ?? 0;
    const h = headingFromOrientation(ev as unknown as OrientationReading, angle);
    if (!h) return;
    got = true;
    opts.onHeading(h);
  };
  window.addEventListener(type, listener);
  const timer = setTimeout(() => {
    if (!got) opts.onNone();
  }, opts.waitMs ?? 2500);
  return () => {
    clearTimeout(timer);
    window.removeEventListener(type, listener);
  };
}
