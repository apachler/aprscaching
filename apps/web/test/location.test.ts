// SPDX-License-Identifier: AGPL-3.0-or-later
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  EVIDENCE_MAX_AGE_MS,
  PATIENT_MS,
  PROBLEM_TEXT,
  LocationError,
  fixFromPosition,
  forgetFix,
  isFresh,
  lastFix,
  locationSupport,
  problemFromCode,
  requestFix,
  toAppGeo,
  watchFixes,
  watchPermission,
  type DeviceFix,
} from "../src/geo/location.js";
import { parseCoordinates, boxAround, haversine } from "../src/map/geo.js";

/** A GeolocationPosition as a browser reports it (the reading's own timestamp, in ms). */
function position(lat: number, lon: number, timestamp: number, accuracy = 8): GeolocationPosition {
  const coords = {
    latitude: lat,
    longitude: lon,
    accuracy,
    altitude: null,
    altitudeAccuracy: null,
    heading: null,
    speed: null,
  };
  return {
    coords: { ...coords, toJSON: () => coords },
    timestamp,
    toJSON: () => ({ coords, timestamp }),
  } as GeolocationPosition;
}
const err = (code: number) =>
  ({ code, message: "", PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3 }) as GeolocationPositionError;

/** A scriptable navigator.geolocation: the test decides when (and whether) a reading arrives. */
function fakeGeo() {
  const watches = new Map<
    number,
    { ok: PositionCallback; bad?: PositionErrorCallback | null; opts?: PositionOptions }
  >();
  let next = 1;
  const geo = {
    watchPosition: vi.fn((ok: PositionCallback, bad?: PositionErrorCallback | null, opts?: PositionOptions) => {
      watches.set(next, { ok, bad, opts });
      return next++;
    }),
    clearWatch: vi.fn((id: number) => void watches.delete(id)),
    getCurrentPosition: vi.fn(),
  };
  return {
    geo: geo as unknown as Geolocation,
    spy: geo,
    watches,
    emit: (p: GeolocationPosition) => [...watches.values()].forEach((w) => w.ok(p)),
    fail: (code: number) => [...watches.values()].forEach((w) => w.bad?.(err(code))),
  };
}

const T0 = 1_760_000_000_000;

beforeEach(() => {
  forgetFix();
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("error mapping and copy", () => {
  it("maps each GeolocationPositionError code", () => {
    expect(problemFromCode(1)).toBe("denied");
    expect(problemFromCode(2)).toBe("unavailable");
    expect(problemFromCode(3)).toBe("timeout");
  });

  it("names an insecure page and a browser without geolocation", () => {
    expect(locationSupport({ isSecureContext: false, navigator: { geolocation: {} } })).toBe("insecure");
    expect(locationSupport({ isSecureContext: true, navigator: {} })).toBe("unsupported");
    expect(locationSupport({ isSecureContext: true, navigator: { geolocation: {} } })).toBeNull();
  });

  it("says in one line what happened and how to fix it", () => {
    for (const text of Object.values(PROBLEM_TEXT)) {
      expect(text).not.toMatch(/\n/);
      expect(text.length).toBeLessThan(140);
    }
    expect(PROBLEM_TEXT.denied).toMatch(/blocked for this site/i);
    expect(PROBLEM_TEXT.denied).toMatch(/site settings.*Firefox: Settings → Site permissions → Location/);
    expect(PROBLEM_TEXT.unavailable).toMatch(/turn on/i);
    expect(PROBLEM_TEXT.unavailable).toMatch(/outdoors/i);
    expect(PROBLEM_TEXT.timeout).toMatch(/outdoors/i);
    expect(PROBLEM_TEXT.insecure).toMatch(/https/);
    expect(PROBLEM_TEXT.insecure).toMatch(/localhost/);
  });
});

describe("a site blocked before any request", () => {
  it("is seen from the permission state, and a later change is followed", async () => {
    const status = { state: "denied" as PermissionState, onchange: null as null | (() => void) };
    const permissions = { query: vi.fn(async () => status) } as unknown as Permissions;
    const seen: (PermissionState | null)[] = [];
    const stop = watchPermission((s) => seen.push(s), permissions);
    await vi.advanceTimersByTimeAsync(0);
    expect(permissions.query).toHaveBeenCalledWith({ name: "geolocation" });
    expect(seen).toEqual(["denied"]);
    status.state = "prompt";
    status.onchange?.();
    expect(seen).toEqual(["denied", "prompt"]);
    stop();
    expect(status.onchange).toBeNull();
  });

  it("reports nothing where the Permissions API is missing or refuses the query", async () => {
    const seen: unknown[] = [];
    watchPermission((s) => seen.push(s), undefined);
    watchPermission((s) => seen.push(s), { query: () => Promise.reject(new Error("no")) } as unknown as Permissions);
    await vi.advanceTimersByTimeAsync(0);
    expect(seen).toEqual([null, null]);
  });
});

describe("the device reading keeps its own timestamp", () => {
  it("builds appGeo with the reading's time, not the time of sending", () => {
    const fix = fixFromPosition(position(47.07, 15.42, T0 - 45_000, 12));
    vi.setSystemTime(T0 + 30_000);
    expect(toAppGeo(fix)).toEqual({ lat: 47.07, lon: 15.42, accuracyM: 12, ts: Math.floor((T0 - 45_000) / 1000) });
  });

  it("reuses a fresh reading unchanged and refuses a stale one", async () => {
    const f = fakeGeo();
    const first = requestFix({ maxAgeMs: EVIDENCE_MAX_AGE_MS, geo: f.geo });
    f.emit(position(47.07, 15.42, T0));
    const fix = await first;
    vi.setSystemTime(T0 + 20_000);
    const again = await requestFix({ maxAgeMs: EVIDENCE_MAX_AGE_MS, geo: f.geo });
    expect(again).toBe(fix);
    expect(toAppGeo(again).ts).toBe(Math.floor(T0 / 1000));
    expect(f.spy.watchPosition).toHaveBeenCalledTimes(1);

    vi.setSystemTime(T0 + EVIDENCE_MAX_AGE_MS + 1);
    expect(isFresh(fix, EVIDENCE_MAX_AGE_MS)).toBe(false);
    const stale = requestFix({ maxAgeMs: EVIDENCE_MAX_AGE_MS, geo: f.geo });
    expect(f.spy.watchPosition).toHaveBeenCalledTimes(2);
    f.emit(position(47.08, 15.43, T0 + EVIDENCE_MAX_AGE_MS + 500));
    expect(toAppGeo(await stale).ts).toBe(Math.floor((T0 + EVIDENCE_MAX_AGE_MS + 500) / 1000));
  });

  it("the evidence window sits inside the gateway's Tier B window", () => {
    // workers/gateway/src/verify.ts DEFAULT_POLICY.appMaxAgeSec
    const verify = readFileSync(new URL("../../../workers/gateway/src/verify.ts", import.meta.url), "utf8");
    const gatewaySec = Number(/appMaxAgeSec:\s*(\d+)/.exec(verify)?.[1]);
    expect(gatewaySec).toBeGreaterThan(0);
    expect(EVIDENCE_MAX_AGE_MS / 1000).toBeLessThan(gatewaySec);
  });
});

describe("appGeo is built only from a GeolocationPosition", () => {
  it("refuses a typed coordinate, a copied fix and a plain object", () => {
    const typed = parseCoordinates("47.0736, 15.4379")!;
    expect(typed).toEqual({ lat: 47.0736, lon: 15.4379 });
    expect(() => toAppGeo(typed as unknown as DeviceFix)).toThrow();
    const real = fixFromPosition(position(47.07, 15.42, T0));
    expect(() => toAppGeo({ ...real })).toThrow();
    expect(() => toAppGeo({ lat: 1, lon: 2, accuracyM: 5, at: T0 } as DeviceFix)).toThrow();
    expect(() => toAppGeo(real)).not.toThrow();
  });

  it("the find log and the stage unlock take appGeo from toAppGeo alone", () => {
    for (const file of ["../src/log/LogForm.tsx", "../src/log/StagesSection.tsx"]) {
      const src = readFileSync(new URL(file, import.meta.url), "utf8");
      // no typed-coordinate parser and no direct browser reading in the evidence path
      expect(src, file).not.toMatch(/parseCoordinates|gridCenter|navigator\.geolocation/);
      // every appGeo value handed to the API comes out of toAppGeo(fix)
      const built = [...src.matchAll(/appGeo\s*[:=]\s*([^,;\n)]+)/g)].map((m) => m[1]!.trim());
      for (const expr of built) expect(expr, `${file}: appGeo = ${expr}`).toMatch(/toAppGeo\(|^undefined$|^AppGeo\b/);
      expect(src, file).toMatch(/toAppGeo\(/);
    }
  });
});

describe("a patient first fix", () => {
  it("waits past ten seconds and reports progress", async () => {
    const f = fakeGeo();
    const ticks: number[] = [];
    const p = requestFix({ maxAgeMs: EVIDENCE_MAX_AGE_MS, geo: f.geo, onWaiting: (ms) => ticks.push(ms) });
    expect(f.watches.values().next().value?.opts).toMatchObject({ enableHighAccuracy: true });
    expect(f.watches.values().next().value?.opts?.timeout).toBeUndefined();
    await vi.advanceTimersByTimeAsync(45_000);
    expect(ticks.at(-1)).toBeGreaterThanOrEqual(44_000);
    f.emit(position(47.07, 15.42, T0 + 45_000));
    const fix = await p;
    expect(fix.lat).toBe(47.07);
    expect(lastFix()).toBe(fix);
    expect(f.spy.clearWatch).toHaveBeenCalled();
  });

  it("gives up after the patient timeout", async () => {
    const f = fakeGeo();
    const p = requestFix({ maxAgeMs: EVIDENCE_MAX_AGE_MS, geo: f.geo });
    const seen = p.catch((e: LocationError) => e.kind);
    await vi.advanceTimersByTimeAsync(PATIENT_MS);
    expect(await seen).toBe("timeout");
    expect(PATIENT_MS).toBeGreaterThanOrEqual(60_000);
  });

  it("keeps waiting through an unavailable reading, and names it if nothing follows", async () => {
    const f = fakeGeo();
    const hints: (string | null)[] = [];
    const p = requestFix({ maxAgeMs: EVIDENCE_MAX_AGE_MS, geo: f.geo, onWaiting: (_ms, hint) => hints.push(hint) });
    const seen = p.catch((e: LocationError) => e.kind);
    f.fail(2);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(hints.at(-1)).toBe("unavailable");
    await vi.advanceTimersByTimeAsync(PATIENT_MS);
    expect(await seen).toBe("unavailable");
  });

  it("stops at once when permission is denied", async () => {
    const f = fakeGeo();
    const p = requestFix({ maxAgeMs: EVIDENCE_MAX_AGE_MS, geo: f.geo }).catch((e: LocationError) => e.kind);
    f.fail(1);
    expect(await p).toBe("denied");
    expect(f.watches.size).toBe(0);
  });

  it("can be cancelled", async () => {
    const f = fakeGeo();
    const ac = new AbortController();
    const p = requestFix({ maxAgeMs: EVIDENCE_MAX_AGE_MS, geo: f.geo, signal: ac.signal }).catch(
      (e: LocationError) => e.kind,
    );
    await vi.advanceTimersByTimeAsync(5_000);
    ac.abort();
    expect(await p).toBe("cancelled");
    expect(f.watches.size).toBe(0);
  });
});

describe("the map's continuous watch", () => {
  it("delivers every reading, remembers the last, and stops on denial", () => {
    const f = fakeGeo();
    const fixes: DeviceFix[] = [];
    const problems: string[] = [];
    const stop = watchFixes({ geo: f.geo, onFix: (x) => fixes.push(x), onProblem: (k) => problems.push(k) });
    f.emit(position(47.07, 15.42, T0));
    f.fail(2);
    f.emit(position(47.08, 15.42, T0 + 1000));
    expect(fixes.map((x) => x.lat)).toEqual([47.07, 47.08]);
    expect(lastFix()).toBe(fixes[1]);
    expect(problems).toEqual(["unavailable"]);
    f.fail(1);
    expect(problems.at(-1)).toBe("denied");
    expect(f.watches.size).toBe(0);
    stop();
  });
});

describe("typed coordinates", () => {
  it("reads decimal degrees and Maidenhead locators", () => {
    expect(parseCoordinates("47.07355, 15.43785")).toEqual({ lat: 47.07355, lon: 15.43785 });
    expect(parseCoordinates("-33.9 18.4")).toEqual({ lat: -33.9, lon: 18.4 });
    const g = parseCoordinates("JN77rb")!;
    expect(g.lat).toBeCloseTo(47.0625, 3);
    expect(g.lon).toBeCloseTo(15.4583, 3);
    expect(parseCoordinates("95, 10")).toBeNull();
    expect(parseCoordinates("hello")).toBeNull();
  });
});

describe("the box Nearby loads around you", () => {
  it("reaches about the asked distance in every direction, wider in longitude away from the equator", () => {
    const [w, s, e, n] = boxAround(47.5, 13.5, 10);
    expect(haversine(47.5, 13.5, n, 13.5)).toBeCloseTo(10_000, -2);
    expect(haversine(47.5, 13.5, 47.5, e)).toBeCloseTo(10_000, -2);
    expect(13.5 - w).toBeCloseTo(e - 13.5);
    expect(47.5 - s).toBeCloseTo(n - 47.5);
    expect(boxAround(89.99, 0, 10)[3]).toBe(90);
  });
});
