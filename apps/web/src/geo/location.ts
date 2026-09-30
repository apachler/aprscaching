// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The one way the app reads the device's location. Pure logic over an injectable
 * `navigator.geolocation`; `useLocate` is the thin React hook on top.
 *
 * A phone without a network location provider (an AOSP build without Google Play Services, say) gets
 * its first fix from GPS alone: that needs a view of the sky and can take minutes, and indoors it may
 * never come. So a request here is patient — it watches for up to `PATIENT_MS`, reports how long it
 * has waited, and can be cancelled — instead of failing after a few seconds.
 *
 * The trust rule: device-reported geolocation is the only in-app location evidence (Tier B, see
 * workers/gateway/src/verify.ts). A `DeviceFix` is made only from a `GeolocationPosition`, keeps that
 * reading's own timestamp and accuracy when it is reused, and `toAppGeo` accepts nothing else. A
 * coordinate the user types is their claim, not evidence, and can never become an `appGeo`.
 */
import type { AppGeo } from "../api.js";

/** Why no reading came. */
export type LocationProblem = "denied" | "unavailable" | "timeout" | "insecure" | "unsupported";

/** One reading the device's geolocation reported. `at` is the reading's own time (ms since the epoch). */
export interface DeviceFix {
  readonly lat: number;
  readonly lon: number;
  readonly accuracyM: number;
  readonly at: number;
}

/** How long a request waits for a first fix: a cold GPS-only start outdoors fits in two minutes. */
export const PATIENT_MS = 120_000;
/**
 * The oldest reading a find log or stage unlock reuses. The gateway takes a reading within
 * `appMaxAgeSec` of the log; this leaves room for the confirm step between the fix and the send.
 */
export const EVIDENCE_MAX_AGE_MS = 60_000;
/** The oldest reading worth reusing for a bearing or a pin: a walker moves little in half a minute. */
export const NAV_MAX_AGE_MS = 30_000;
/** The oldest reading worth reusing for a distance shown in passing. */
export const GLANCE_MAX_AGE_MS = 300_000;

/**
 * One line each: what happened, and how to fix it. A browser whose site-permission default is "Blocked"
 * (a Firefox setting) denies every request without a prompt or an address-bar icon, so the denied line
 * names where the setting lives.
 */
export const PROBLEM_TEXT: Record<LocationProblem, string> = {
  denied:
    "Location is blocked for this site — allow it in your browser's site settings (Firefox: Settings → Site permissions → Location).",
  unavailable: "No location from this device. Turn on location and go outdoors, then try again.",
  timeout: "Still no GPS fix. Step outdoors with a clear view of the sky and try again.",
  insecure: "Location needs a secure page. Open this site over https or on localhost.",
  unsupported: "This browser can't share its location.",
};

/** The progress line while a request waits. */
export function waitingText(elapsedMs: number, hint: LocationProblem | null): string {
  const s = Math.floor(elapsedMs / 1000);
  if (elapsedMs >= PATIENT_MS) return `Still waiting for GPS… ${s} s. Step outdoors with a clear view of the sky.`;
  if (hint === "unavailable") return `Waiting for GPS… ${s} s. Is location turned on?`;
  return s >= 15 ? `Waiting for GPS… ${s} s. Outdoors is faster.` : `Waiting for GPS… ${s} s`;
}

/** A failed or cancelled request. */
export class LocationError extends Error {
  constructor(readonly kind: LocationProblem | "cancelled") {
    super(kind === "cancelled" ? "cancelled" : PROBLEM_TEXT[kind]);
  }
}

/** The GeolocationPositionError code (1 denied, 2 unavailable, 3 timeout) as a problem. */
export function problemFromCode(code: number): LocationProblem {
  return code === 1 ? "denied" : code === 3 ? "timeout" : "unavailable";
}

/** Whether this page can ask for a location at all: geolocation exists only in a secure context. */
export function locationSupport(
  env: { isSecureContext?: boolean; navigator?: { geolocation?: unknown } } = globalThis,
): LocationProblem | null {
  if (env.isSecureContext === false) return "insecure";
  if (!env.navigator?.geolocation) return "unsupported";
  return null;
}

// Every DeviceFix this module made from a GeolocationPosition. `toAppGeo` checks membership, so an
// object assembled anywhere else — from typed input, a copy, a URL — is refused.
const DEVICE = new WeakSet<DeviceFix>();
let last: DeviceFix | null = null;

/** The device's reading, with its own timestamp and accuracy. The only constructor of a DeviceFix. */
export function fixFromPosition(p: GeolocationPosition): DeviceFix {
  const fix: DeviceFix = Object.freeze({
    lat: p.coords.latitude,
    lon: p.coords.longitude,
    accuracyM: Number.isFinite(p.coords.accuracy) ? p.coords.accuracy : 9999,
    at: p.timestamp,
  });
  DEVICE.add(fix);
  last = fix;
  return fix;
}

/** The in-app location evidence for a find log or stage unlock, stamped with the reading's own time. */
export function toAppGeo(fix: DeviceFix): AppGeo {
  if (!DEVICE.has(fix)) throw new Error("appGeo takes a device reading only");
  return { lat: fix.lat, lon: fix.lon, accuracyM: fix.accuracyM, ts: Math.floor(fix.at / 1000) };
}

/** Whether a reading is at most `maxAgeMs` old. */
export function isFresh(fix: DeviceFix, maxAgeMs: number, now = Date.now()): boolean {
  return now - fix.at <= maxAgeMs;
}

/** The most recent reading this page received, if any. */
export function lastFix(): DeviceFix | null {
  return last;
}

/** Drop the remembered reading. */
export function forgetFix(): void {
  last = null;
}

/**
 * The site's geolocation permission, now and on every change: "denied" means a request fails at once,
 * with no prompt. Null where the Permissions API is missing or refuses the query (it is advisory — a
 * request is the real test). Returns the stop function.
 */
export function watchPermission(
  cb: (state: PermissionState | null) => void,
  permissions: Permissions | undefined = globalThis.navigator?.permissions,
): () => void {
  let status: PermissionStatus | null = null;
  let live = true;
  if (!permissions) cb(null);
  else
    permissions
      .query({ name: "geolocation" })
      .then((s) => {
        if (!live) return;
        status = s;
        s.onchange = () => cb(s.state);
        cb(s.state);
      })
      .catch(() => live && cb(null));
  return () => {
    live = false;
    if (status) status.onchange = null;
  };
}

/** High accuracy asks for GPS; no browser timeout, since the waiting is bounded here instead. */
const watchOptions = (maxAgeMs: number): PositionOptions => ({ enableHighAccuracy: true, maximumAge: maxAgeMs });

/**
 * One reading, at most `maxAgeMs` old. A fresh remembered reading is returned as it is; otherwise a
 * watch runs until the first reading, denial, cancellation or `timeoutMs`. A POSITION_UNAVAILABLE
 * report does not end the wait — a GPS-only phone reports it before its first fix — but it names the
 * failure if nothing follows.
 */
export function requestFix(opts: {
  maxAgeMs: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  onWaiting?: (elapsedMs: number, hint: LocationProblem | null) => void;
  geo?: Geolocation;
}): Promise<DeviceFix> {
  if (last && isFresh(last, opts.maxAgeMs)) return Promise.resolve(last);
  const geo = opts.geo ?? (locationSupport() ? undefined : navigator.geolocation);
  if (!geo) return Promise.reject(new LocationError(locationSupport() ?? "unsupported"));
  if (opts.signal?.aborted) return Promise.reject(new LocationError("cancelled"));
  const started = Date.now();
  return new Promise<DeviceFix>((resolve, reject) => {
    let hint: LocationProblem | null = null;
    const done = () => {
      geo.clearWatch(id);
      clearInterval(tick);
      clearTimeout(limit);
      opts.signal?.removeEventListener("abort", onAbort);
    };
    const fail = (kind: LocationProblem | "cancelled") => {
      done();
      reject(new LocationError(kind));
    };
    const onAbort = () => fail("cancelled");
    const id = geo.watchPosition(
      (p) => {
        done();
        resolve(fixFromPosition(p));
      },
      (e) => {
        const kind = problemFromCode(e.code);
        if (kind === "denied") fail("denied");
        else {
          hint = kind === "unavailable" ? kind : hint;
          opts.onWaiting?.(Date.now() - started, hint);
        }
      },
      watchOptions(opts.maxAgeMs),
    );
    const tick = setInterval(() => opts.onWaiting?.(Date.now() - started, hint), 1000);
    const limit = setTimeout(() => fail(hint ?? "timeout"), opts.timeoutMs ?? PATIENT_MS);
    opts.signal?.addEventListener("abort", onAbort);
  });
}

/**
 * A continuous watch for the map's locate control. Every reading is delivered (and remembered);
 * POSITION_UNAVAILABLE is reported and the watch goes on; a denial ends it. Returns the stop function.
 */
export function watchFixes(opts: {
  onFix: (fix: DeviceFix) => void;
  onProblem: (kind: LocationProblem) => void;
  geo?: Geolocation;
}): () => void {
  const geo = opts.geo ?? (locationSupport() ? undefined : navigator.geolocation);
  if (!geo) {
    opts.onProblem(locationSupport() ?? "unsupported");
    return () => {};
  }
  let id: number | null = geo.watchPosition(
    (p) => opts.onFix(fixFromPosition(p)),
    (e) => {
      const kind = problemFromCode(e.code);
      if (kind === "denied") stop();
      if (kind !== "timeout") opts.onProblem(kind);
    },
    watchOptions(NAV_MAX_AGE_MS),
  );
  function stop() {
    if (id != null) geo!.clearWatch(id);
    id = null;
  }
  return stop;
}
