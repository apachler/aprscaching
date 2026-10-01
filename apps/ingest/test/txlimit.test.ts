// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ParsedFrame } from "@aprscaching/aprs";
import { TokenBucket, TX_LIMITS, txLimitFromEnv } from "../src/txlimit.js";
import { Igate } from "../src/igate.js";
import { forwardAdmit } from "../src/forwarder.js";
import type { KissTnc } from "../src/kiss.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("TokenBucket", () => {
  it("allows a burst, then one transmit per refill interval", () => {
    const clock = { t: 0 };
    const b = new TokenBucket({ burst: 2, refillSec: 30, now: () => clock.t });
    expect([b.take(), b.take(), b.take()]).toEqual([true, true, false]);
    expect(b.waitSec()).toBe(30);
    clock.t += 15_000;
    expect(b.take()).toBe(false);
    expect(b.waitSec()).toBe(15);
    clock.t += 15_000;
    expect(b.take()).toBe(true);
    expect(b.take()).toBe(false);
  });

  it("banks no more than a full burst however long it idles", () => {
    const clock = { t: 0 };
    const b = new TokenBucket({ burst: 3, refillSec: 60, now: () => clock.t });
    clock.t += 24 * 3_600_000;
    expect([b.take(), b.take(), b.take(), b.take()]).toEqual([true, true, true, false]);
  });
});

describe("txLimitFromEnv", () => {
  const keys = Object.values(TX_LIMITS).flatMap((s) => [s.burstEnv, s.refillEnv]);
  afterEach(() => {
    for (const k of keys) delete process.env[k];
  });

  it("uses each path's defaults when nothing is set", () => {
    expect(txLimitFromEnv("box")).toEqual({ burst: 3, refillSec: 60 });
    expect(txLimitFromEnv("meshcom")).toEqual({ burst: 3, refillSec: 60 });
    expect(txLimitFromEnv("igate")).toEqual({ burst: 6, refillSec: 10 });
    expect(txLimitFromEnv("bbs")).toEqual({ burst: 4, refillSec: 300 });
  });

  it("takes a tighter setting as given", () => {
    process.env.BOX_TX_BURST = "1";
    process.env.BOX_TX_REFILL_SEC = "600";
    expect(txLimitFromEnv("box")).toEqual({ burst: 1, refillSec: 600 });
  });

  it("clamps a looser setting to the ceiling, with a warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env.IGATE_TX_BURST = "100";
    process.env.IGATE_TX_REFILL_SEC = "1";
    process.env.BBS_FORWARD_REFILL_SEC = "5";
    expect(txLimitFromEnv("igate")).toEqual({ burst: 10, refillSec: 6 });
    expect(txLimitFromEnv("bbs").refillSec).toBe(60);
    expect(warn).toHaveBeenCalledTimes(3);
  });

  it("refuses a zero or non-numeric burst", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env.MESHCOM_TX_BURST = "0";
    expect(txLimitFromEnv("meshcom").burst).toBe(1);
    process.env.MESHCOM_TX_BURST = "lots";
    expect(txLimitFromEnv("meshcom").burst).toBe(3);
  });
});

describe("TX-IGate pacing", () => {
  const heard = (src: string): ParsedFrame => ({ src, dst: "APRS", path: [], payload: ">here" }) as ParsedFrame;
  const radio = () => {
    const sent: unknown[] = [];
    const kiss = { send: (f: unknown) => (sent.push(f), true) } as unknown as KissTnc;
    return { sent, kiss };
  };

  it("gates messages for a local station up to the bucket, then logs the refusals", () => {
    const { sent, kiss } = radio();
    const clock = { t: 0 };
    const igate = new Igate(kiss, {
      host: "localhost",
      port: 14580,
      call: "OE8APR-10",
      pass: "-1",
      burst: 2,
      refillSec: 60,
      now: () => clock.t,
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    igate.onRf(heard("OE3ABC-7"));
    const msg = (n: number) => `DL1XYZ>APRS,WIDE1-1,qAR,DB0ABC::OE3ABC-7 :hello${n}{${n}`;
    for (let i = 1; i <= 4; i++) igate.onIsLine(msg(i));
    expect(sent).toHaveLength(2);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(String(warn.mock.calls[0]![0])).toMatch(/rate limited — message for OE3ABC-7/);
    clock.t += 60_000;
    igate.onIsLine(msg(5));
    expect(sent).toHaveLength(3);
  });

  it("transmits an APRS-IS client message as third-party traffic under its own call", () => {
    const { sent, kiss } = radio();
    const igate = new Igate(kiss, {
      host: "localhost",
      port: 14580,
      call: "OE8APR-10",
      pass: "-1",
      txPath: ["WIDE1-1"],
    });
    vi.spyOn(console, "log").mockImplementation(() => {});
    igate.onRf(heard("OE3ABC-7"));
    igate.onIsLine("DL1XYZ>APRS,TCPIP*,qAC,T2AUSTRIA::OE3ABC-7 :hello{1");
    expect(sent).toEqual([
      {
        src: "OE8APR-10",
        dst: "APZACG",
        path: ["WIDE1-1"],
        payload: "}DL1XYZ>APRS,TCPIP,OE8APR-10*::OE3ABC-7 :hello{1",
      },
    ]);
  });

  it("spends no token on a line it would not gate", () => {
    const { sent, kiss } = radio();
    const igate = new Igate(kiss, { host: "localhost", port: 14580, call: "OE8APR-10", pass: "-1", burst: 1 });
    vi.spyOn(console, "log").mockImplementation(() => {});
    igate.onIsLine("DL1XYZ>APRS,WIDE1-1,qAR,DB0ABC::DK9ZZZ   :not heard here{1");
    igate.onRf(heard("OE3ABC-7"));
    igate.onIsLine("DL1XYZ>APRS,WIDE1-1,qAR,DB0ABC::OE3ABC-7 :hello{2");
    expect(sent).toHaveLength(1);
  });
});

describe("FBB forwarding session gate", () => {
  it("admits sessions up to the bucket and logs each deferral", () => {
    const clock = { t: 0 };
    const admit = forwardAdmit(new TokenBucket({ burst: 1, refillSec: 300, now: () => clock.t }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const p = { call: "DB0XYZ-1" } as Parameters<typeof admit>[0];
    expect(admit(p)).toBe(true);
    expect(admit(p)).toBe(false);
    expect(String(warn.mock.calls[0]![0])).toMatch(/session with DB0XYZ-1 deferred \(next in 300 s\)/);
    clock.t += 300_000;
    expect(admit(p)).toBe(true);
  });
});
