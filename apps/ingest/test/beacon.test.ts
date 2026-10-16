// SPDX-License-Identifier: AGPL-3.0-or-later
// The automatic beacons: fixed interval, SmartBeaconing with corner pegging, the HF preset, the frame each sends
// and every gate a beacon passes.
import { describe, it, expect } from "vitest";
import { decodeMicE, HF_APRS } from "@aprscaching/aprs";
import {
  BeaconScheduler,
  beaconSettings,
  smartRateSec,
  turnThresholdDeg,
  type BeaconPort,
  type BeaconSettings,
} from "../src/beacon.js";
import type { Fix, PositionSource } from "../src/gps.js";
import { TokenBucket } from "../src/txlimit.js";

type Sent = { src: string; dst: string; path?: string[]; payload: string };

function setup(o: { settings?: Partial<BeaconSettings>; hf?: boolean; fix?: Partial<Fix>; burst?: number } = {}) {
  let t = 1_700_000_000_000;
  const sent: Sent[] = [];
  let tx = true;
  let portOk = true;
  const settings: BeaconSettings = {
    mode: "fixed",
    source: "fixed",
    intervalMin: 20,
    symbol: "/-",
    comment: "APRScaching box",
    commentEvery: 1,
    slowRateSec: 1800,
    fastRateSec: 90,
    gpsd: { host: "127.0.0.1", port: 2947 },
    ...o.settings,
  };
  let fix: Fix | null = { lat: 47.07, lon: 15.42, speedKmh: 0, at: t, ...o.fix };
  let frozen = false;
  const source: PositionSource = {
    kind: settings.source,
    // a live source keeps reporting, unless the test freezes it
    latest: () => (fix ? { ...fix, at: frozen ? fix.at : t } : null),
    start: () => {},
    stop: () => {},
  };
  const port: BeaconPort = {
    hf: o.hf,
    send: (f) => {
      if (portOk) sent.push(f);
      return portOk;
    },
  };
  const bucket = new TokenBucket({ burst: o.burst ?? 2, refillSec: 60, now: () => t });
  const s = new BeaconScheduler({
    settings,
    source,
    port,
    call: "oe8apr-10",
    path: ["WIDE1-1", "WIDE2-1"],
    canTx: () => tx,
    bucket,
    now: () => t,
    log: () => {},
  });
  const run = (sec: number) => {
    for (let i = 0; i < sec; i += 5) {
      t += 5000;
      s.tick();
    }
  };
  return {
    s,
    sent,
    run,
    now: () => t,
    move: (f: Partial<Fix>) => {
      fix = { ...(fix as Fix), ...f, at: t };
    },
    lose: () => {
      fix = null;
    },
    freeze: () => {
      frozen = true;
    },
    setTx: (v: boolean) => {
      tx = v;
    },
    setPort: (v: boolean) => {
      portOk = v;
    },
  };
}

describe("beacon settings", () => {
  it("is off unless BEACON says fixed or smart", () => {
    expect(beaconSettings({})).toBeNull();
    expect(beaconSettings({ BEACON: "off" })).toBeNull();
    expect(() => beaconSettings({ BEACON: "often" })).toThrow(/BEACON/);
  });

  it("defaults: 20 min, never under 10, a symbol for the source, gpsd on localhost", () => {
    expect(beaconSettings({ BEACON: "fixed" })).toMatchObject({ intervalMin: 20, symbol: "/-", source: "fixed" });
    expect(beaconSettings({ BEACON: "fixed", BEACON_INTERVAL_MIN: "2" })!.intervalMin).toBe(10);
    expect(beaconSettings({ BEACON: "smart", BEACON_POSITION: "termux" })!.symbol).toBe("/[");
    expect(beaconSettings({ BEACON: "smart", BEACON_POSITION: "gpsd", BEACON_GPSD: "gps.lan:3000" })).toMatchObject({
      symbol: "/>",
      gpsd: { host: "gps.lan", port: 3000 },
    });
    expect(() => beaconSettings({ BEACON: "smart", BEACON_POSITION: "nmea" })).toThrow(/BEACON_NMEA_DEVICE/);
    expect(() => beaconSettings({ BEACON: "fixed", BEACON_SYMBOL: "house" })).toThrow(/BEACON_SYMBOL/);
    expect(beaconSettings({ BEACON: "smart" })).toMatchObject({ slowRateSec: 1800, fastRateSec: 90 });
    expect(beaconSettings({ BEACON: "smart", BEACON_SLOW_MIN: "4", BEACON_FAST_SEC: "60" })).toMatchObject({
      slowRateSec: 240,
      fastRateSec: 60,
    });
    // bounded: the slow rate 1–60 min, the fast 30–600 s and never slower than the slow
    expect(beaconSettings({ BEACON: "smart", BEACON_SLOW_MIN: "0", BEACON_FAST_SEC: "5" })).toMatchObject({
      slowRateSec: 60,
      fastRateSec: 30,
    });
    expect(beaconSettings({ BEACON: "smart", BEACON_SLOW_MIN: "2", BEACON_FAST_SEC: "600" })!.fastRateSec).toBe(120);
  });
});

describe("fixed interval", () => {
  it("beacons at once, then every interval, an uncompressed position with the comment", () => {
    const { sent, run } = setup();
    run(5);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual({
      src: "OE8APR-10",
      dst: "APZACG",
      path: ["WIDE1-1", "WIDE2-1"],
      payload: "!4704.20N/01525.20E-APRScaching box",
    });
    run(20 * 60 - 10);
    expect(sent).toHaveLength(1);
    run(10);
    expect(sent).toHaveLength(2);
  });

  it("carries the comment on one beacon in BEACON_COMMENT_EVERY", () => {
    const { sent, run } = setup({ settings: { commentEvery: 3, intervalMin: 10 } });
    run(5 + 3 * 600);
    expect(sent.map((f) => f.payload.endsWith("APRScaching box"))).toEqual([true, false, false, true]);
  });
});

describe("SmartBeaconing", () => {
  it("rates: 30 min below 5 km/h, 90 s from 90 km/h, fast_rate × high_speed / speed between", () => {
    expect(smartRateSec(0)).toBe(1800);
    expect(smartRateSec(4.9)).toBe(1800);
    expect(smartRateSec(45)).toBe(180);
    expect(smartRateSec(90)).toBe(90);
    expect(smartRateSec(130)).toBe(90);
    // turn_min 28° plus 255 degree·mph over the speed
    expect(turnThresholdDeg(80.4672)).toBeCloseTo(28 + 255 / 50, 5);
    // a living cache's slow rate caps every rate
    expect(smartRateSec(0, { slowRateSec: 240, fastRateSec: 60 })).toBe(240);
    expect(smartRateSec(10, { slowRateSec: 240, fastRateSec: 60 })).toBe(240);
    expect(smartRateSec(90, { slowRateSec: 240, fastRateSec: 60 })).toBe(60);
  });

  it("beacons by speed, Mic-E with course and speed for a moving source", () => {
    const { sent, run, move } = setup({
      settings: { mode: "smart", source: "gpsd", symbol: "/>" },
      fix: { speedKmh: 100, course: 90 },
    });
    run(5);
    expect(sent).toHaveLength(1);
    const f = decodeMicE(sent[0]!.dst, sent[0]!.payload)!;
    expect(f.lat).toBeCloseTo(47.07, 3);
    expect(f.speedKn! * 1.852).toBeCloseTo(100, -1);
    expect(f.course).toBe(90);
    move({ speedKmh: 100, course: 90 });
    run(85);
    expect(sent).toHaveLength(1);
    run(5);
    expect(sent).toHaveLength(2);
    move({ speedKmh: 2 });
    run(1795);
    expect(sent).toHaveLength(2);
  });

  it("pegs a corner sharper than the threshold, once turn_time has passed", () => {
    const { sent, run, move } = setup({
      settings: { mode: "smart", source: "nmea", symbol: "/>" },
      fix: { speedKmh: 50, course: 10 },
    });
    run(5);
    expect(sent).toHaveLength(1);
    // 25° is under 28 + 255/31 ≈ 36°: no corner
    move({ course: 35 });
    run(25);
    expect(sent).toHaveLength(1);
    // 45° is over it, but turn_time is 30 s
    move({ course: 55 });
    run(0);
    expect(sent).toHaveLength(1);
    run(5);
    expect(sent).toHaveLength(2);
    // straight on: the next comes at the speed's rate, 162 s at 50 km/h
    run(155);
    expect(sent).toHaveLength(2);
    run(10);
    expect(sent).toHaveLength(3);
  });

  it("sends nothing on a stale or missing fix", () => {
    const { sent, run, lose, freeze, move } = setup({
      settings: { mode: "smart", source: "termux" },
      fix: { speedKmh: 60 },
    });
    run(5);
    move({});
    freeze();
    // the fix stops updating: after 2 min it is stale
    run(3 * 60);
    const n = sent.length;
    // the beacon due 135 s on finds a fix 130 s old
    expect(n).toBe(1);
    run(10 * 60);
    expect(sent).toHaveLength(n);
    lose();
    run(60);
    expect(sent).toHaveLength(n);
  });
});

describe("a living cache's slow rate", () => {
  it("beacons a parked station every 4 min, and the HF floor of 10 min still holds", () => {
    const vhf = setup({ settings: { mode: "smart", source: "termux", slowRateSec: 240 }, fix: { speedKmh: 0 } });
    vhf.run(5 + 3 * 240);
    expect(vhf.sent).toHaveLength(4);
    const hf = setup({ hf: true, settings: { mode: "smart", source: "termux", slowRateSec: 240 } });
    hf.run(5 + 3 * 240);
    expect(hf.sent).toHaveLength(2);
  });
});

describe("the HF preset", () => {
  it("Mic-E with no path, the comment on every fourth, never under 10 min, even moving fast", () => {
    const { sent, run } = setup({
      hf: true,
      settings: { mode: "smart", source: "gpsd" },
      fix: { speedKmh: 120, course: 180 },
    });
    run(5);
    run(HF_APRS.beaconMinSec * 4);
    expect(sent).toHaveLength(5);
    for (const f of sent) expect(f.path).toEqual([]);
    expect(sent.map((f) => f.payload.includes("APRScaching"))).toEqual([true, false, false, false, true]);
    expect(decodeMicE(sent[1]!.dst, sent[1]!.payload)!.lat).toBeCloseTo(47.07, 3);
  });
});

describe("gates", () => {
  it("holds the beacon while transmit is off, the port refuses it or the bucket is empty, and sends once open", () => {
    const { s, sent, run, setTx, setPort } = setup({ settings: { intervalMin: 10 }, burst: 1 });
    setTx(false);
    run(60);
    expect(sent).toHaveLength(0);
    setTx(true);
    setPort(false);
    run(60);
    expect(sent).toHaveLength(0);
    setPort(true);
    run(5);
    expect(sent).toHaveLength(1);
    expect(s.sent).toBe(1);
  });

  it("an empty bucket holds a beacon until it refills", () => {
    const { sent, run } = setup({
      settings: { mode: "smart", source: "gpsd" },
      fix: { speedKmh: 120, course: 0 },
      burst: 1,
    });
    run(5);
    expect(sent).toHaveLength(1);
    // due again after 90 s; the bucket refills one in 60 s, so it is not what holds it
    run(90);
    expect(sent).toHaveLength(2);
  });
});
