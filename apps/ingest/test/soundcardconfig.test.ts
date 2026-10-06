// SPDX-License-Identifier: AGPL-3.0-or-later
// The soundcard settings, the station-call verification the transmit gate reads, and the doctor's checks and
// PTT test, all against fakes.
import { describe, it, expect } from "vitest";
import { validateConfig } from "@aprscaching/shared";
import { soundcardPorts } from "../src/soundcardconfig.js";
import { CallVerifier, gatewayVerifyLookup, stationCalls } from "../src/callverify.js";
import { soundcardChecks, pttTest, type CheckDeps } from "../src/soundcardcheck.js";
import { recordingPtt } from "./fakeaudio.js";

describe("soundcardPorts", () => {
  it("is empty without SOUNDCARD_DEVICE or SOUNDCARD_PORTS", () => {
    expect(soundcardPorts({})).toEqual([]);
  });

  it("reads the first port with its defaults: receive only, no PTT, a 10 s watchdog", () => {
    expect(soundcardPorts({ SOUNDCARD_DEVICE: "plughw:1,0", BOX_CALL: "OE8APR-10" })).toEqual([
      {
        name: "1",
        device: "plughw:1,0",
        playback: "plughw:1,0",
        rate: 48000,
        tx: false,
        ptt: { kind: "none" },
        call: "OE8APR-10",
        txDelayMs: 300,
        txTailMs: 50,
        persist: 63,
        slotTimeMs: 100,
        pttMaxMs: 10_000,
        txLevel: 0.5,
      },
    ]);
  });

  it("reads every setting, and clamps the watchdog to its ceiling", () => {
    const [p] = soundcardPorts({
      SOUNDCARD_DEVICE: "hw:1,0",
      SOUNDCARD_PLAYBACK: "hw:1,1",
      SOUNDCARD_RATE: "44100",
      SOUNDCARD_TX: "1",
      SOUNDCARD_CALL: "OE8APR-11",
      SOUNDCARD_PTT: "gpio:gpiochip0:17",
      SOUNDCARD_PTT_MAX_MS: "120000",
      SOUNDCARD_TXDELAY_MS: "250",
    });
    expect(p).toMatchObject({
      playback: "hw:1,1",
      rate: 44100,
      tx: true,
      call: "OE8APR-11",
      ptt: { kind: "gpio", chip: "gpiochip0", line: 17, invert: false },
      pttMaxMs: 60_000,
      txDelayMs: 250,
    });
  });

  it("adds the ports of SOUNDCARD_PORTS; they inherit timing and call, never transmit or PTT", () => {
    const ports = soundcardPorts({
      SOUNDCARD_DEVICE: "plughw:1,0",
      SOUNDCARD_TX: "1",
      SOUNDCARD_PTT: "cm108",
      SOUNDCARD_TXDELAY_MS: "200",
      DIGI_CALL: "OE8APR-10",
      SOUNDCARD_PORTS: JSON.stringify([
        { device: "plughw:2,0" },
        { name: "uhf", device: "plughw:3,0", tx: true, ptt: "cm108:/dev/hidraw1:4", txDelayMs: 400, pttMaxMs: 5000 },
      ]),
    });
    expect(ports.map((p) => p.name)).toEqual(["1", "2", "uhf"]);
    expect(ports[1]).toMatchObject({ tx: false, ptt: { kind: "none" }, txDelayMs: 200, call: "OE8APR-10" });
    expect(ports[2]).toMatchObject({
      tx: true,
      ptt: { kind: "cm108", path: "/dev/hidraw1", gpio: 4 },
      txDelayMs: 400,
      pttMaxMs: 5000,
    });
  });

  it.each([
    [{ SOUNDCARD_DEVICE: "x", SOUNDCARD_RATE: "8000" }, /SOUNDCARD_RATE/],
    [{ SOUNDCARD_DEVICE: "x", SOUNDCARD_PTT: "cm108:/dev/hidraw0:12" }, /GPIO must be/],
    [{ SOUNDCARD_PORTS: "{}" }, /JSON array/],
    [{ SOUNDCARD_PORTS: "[{}]" }, /SOUNDCARD_PORTS\[0\]\.device/],
    [{ SOUNDCARD_PORTS: '[{"device":"a","speed":1}]' }, /unknown field "speed"/],
    [{ SOUNDCARD_PORTS: '[{"device":"a","ptt":"usb"}]' }, /SOUNDCARD_PORTS\[0\]\.ptt/],
    [{ SOUNDCARD_PORTS: '[{"device":"a","txDelayMs":"300"}]' }, /expected a number/],
    [{ SOUNDCARD_DEVICE: "a", SOUNDCARD_PORTS: '[{"device":"b","name":"1"}]' }, /two ports are named 1/],
  ])("refuses %j", (env, msg) => {
    expect(() => soundcardPorts(env)).toThrow(msg);
  });

  it("the schema validates the keys' types at start", () => {
    const problems = validateConfig(
      { SOUNDCARD_TX: "yes", SOUNDCARD_RATE: "22050", SOUNDCARD_CALL: "NOCALL", SOUNDCARD_PORTS: "[" },
      "ingest",
    ).map((p) => p.key);
    expect(problems.sort()).toEqual(["SOUNDCARD_CALL", "SOUNDCARD_PORTS", "SOUNDCARD_RATE", "SOUNDCARD_TX"]);
  });
});

describe("station-call verification", () => {
  it("lists every call the box transmits under, once", () => {
    expect(
      stationCalls({ DIGI_CALL: "oe8apr-10", IGATE_CALL: "OE8APR-10", NETROM_CALL: "OE8APR-5" }, "OE8APR-11"),
    ).toEqual(["OE8APR-11", "OE8APR-10", "OE8APR-5"]);
  });

  it("knows a call verified once the gateway said so, keeps the answer through an outage", async () => {
    let up = true;
    const asked: string[] = [];
    const v = new CallVerifier(async (c) => {
      asked.push(c);
      if (!up) throw new Error("unreachable");
      return c === "OE8APR";
    });
    expect(v.unverified(["OE8APR-10"])).toBe("OE8APR-10"); // nothing known yet
    await v.refresh(["OE8APR-10", "OE8APR-5", "DL1ABC"]);
    expect(asked).toEqual(["OE8APR", "DL1ABC"]); // one question per base call
    expect(v.unverified(["OE8APR-10", "OE8APR-5"])).toBeNull();
    expect(v.unverified(["OE8APR-10", "DL1ABC-1"])).toBe("DL1ABC-1");
    up = false;
    await v.refresh(["OE8APR-10"]);
    expect(v.unverified(["OE8APR-10"])).toBeNull();
  });

  it("asks the gateway's public verification status", async () => {
    const urls: string[] = [];
    const lookup = gatewayVerifyLookup("http://gw.example", (async (u: string) => {
      urls.push(u);
      return new Response(JSON.stringify({ verified: true }));
    }) as typeof fetch);
    expect(await lookup("OE8APR-10")).toBe(true);
    expect(urls).toEqual(["http://gw.example/verify/aprs/status?callsign=OE8APR-10"]);
  });
});

describe("soundcard doctor checks", () => {
  /** spawnSync for the ALSA tools: installed, and devices that open (or are busy). */
  const alsa =
    (o: { missing?: boolean; captureErr?: string } = {}) =>
    (cmd: string, args: string[]) => {
      if (o.missing) return { status: null, error: Object.assign(new Error("ENOENT"), { code: "ENOENT" }) };
      if (args[0] === "--version") return { status: 0 };
      if (cmd === "arecord" && o.captureErr) return { status: 1, stderr: o.captureErr };
      return { status: 0, stderr: "" };
    };
  const deps = (o: Partial<CheckDeps> = {}): CheckDeps => ({ verified: async () => true, spawnSync: alsa(), ...o });
  const env = { SOUNDCARD_DEVICE: "plughw:1,0", SOUNDCARD_TX: "1", SOUNDCARD_PTT: "none", BOX_CALL: "OE8APR-10" };

  it("reports nothing without a soundcard port", async () => {
    expect(await soundcardChecks({}, deps())).toEqual([]);
  });

  it("passes a working port, and says it never needed to key", async () => {
    const rows = await soundcardChecks(env, deps());
    expect(rows.map((r) => `${r.kind}:${r.status}`)).toEqual([
      "alsa:pass",
      "audio:pass",
      "ptt:pass",
      "tx:pass",
      "tx:pass",
    ]);
    expect(rows[3]!.message).toMatch(/watchdog releases the transmitter after 10000 ms/);
  });

  it("fails on missing ALSA tools and on a capture device that does not open", async () => {
    expect((await soundcardChecks(env, deps({ spawnSync: alsa({ missing: true }) })))[0]).toMatchObject({
      kind: "alsa",
      status: "fail",
      fix: "apt install alsa-utils",
    });
    const rows = await soundcardChecks(
      env,
      deps({ spawnSync: alsa({ captureErr: "arecord: main:831: audio open error: No such file or directory" }) }),
    );
    expect(rows[1]).toMatchObject({ kind: "audio", status: "fail" });
    expect(rows[1]!.message).toMatch(/arecord -l/);
  });

  it("passes a device the running ingest holds", async () => {
    const rows = await soundcardChecks(
      env,
      deps({ spawnSync: alsa({ captureErr: "audio open error: Device or resource busy" }) }),
    );
    expect(rows[1]).toMatchObject({ kind: "audio", status: "pass" });
    expect(rows[1]!.message).toMatch(/in use by the running ingest/);
  });

  it("warns about an unverified call and a long watchdog, and fails an unreachable rigctld", async () => {
    const rows = await soundcardChecks(
      { ...env, SOUNDCARD_PTT: "rigctld", SOUNDCARD_PTT_MAX_MS: "30000" },
      deps({ verified: async () => false, tcpOpen: async () => false }),
    );
    expect(rows.filter((r) => r.status !== "pass").map((r) => `${r.kind}:${r.status}`)).toEqual([
      "ptt:fail",
      "tx:warn",
      "tx:warn",
    ]);
    expect(rows.find((r) => r.kind === "tx" && /not control-verified/.test(r.message))).toBeTruthy();
  });

  it("checks a CM108 PTT without opening it", async () => {
    const rows = await soundcardChecks({ ...env, SOUNDCARD_PTT: "cm108:/nonexistent/hidraw9" }, deps());
    expect(rows.find((r) => r.kind === "ptt")).toMatchObject({
      status: "fail",
      message: expect.stringMatching(/does not exist/),
    });
  });
});

describe("PTT test", () => {
  const env = { SOUNDCARD_DEVICE: "plughw:1,0", SOUNDCARD_TX: "1", SOUNDCARD_PTT: "cm108", BOX_CALL: "OE8APR-10" };

  it("is refused with transmit off", async () => {
    const ptt = recordingPtt();
    const r = await pttTest({ ...env, SOUNDCARD_TX: "" }, undefined, {
      verified: async () => true,
      openPtt: async () => ptt,
    });
    expect(r).toEqual({ ok: false, message: "refused: transmit is off on port 1 (set SOUNDCARD_TX=1)" });
    expect(ptt.events).toEqual([]);
  });

  it("is refused while the call is not verified, or the gateway cannot say", async () => {
    const ptt = recordingPtt();
    const no = await pttTest(env, "1", { verified: async () => false, openPtt: async () => ptt });
    expect(no.message).toBe("refused: verify OE8APR-10 to transmit — control-verification required");
    const down = await pttTest(env, "1", {
      verified: async () => {
        throw new Error("down");
      },
      openPtt: async () => ptt,
    });
    expect(down.ok).toBe(false);
    expect(ptt.events).toEqual([]);
  });

  it("keys under a second and always releases", async () => {
    const ptt = recordingPtt();
    const slept: number[] = [];
    const r = await pttTest(
      env,
      undefined,
      {
        verified: async () => true,
        openPtt: async () => ptt,
        sleep: async (ms) => void slept.push(ms),
      },
      5000,
    );
    expect(r.ok).toBe(true);
    expect(slept).toEqual([900]);
    expect(ptt.events).toEqual(["key", "unkey", "close"]);
  });

  it("names a port that does not exist", async () => {
    expect((await pttTest(env, "uhf", { verified: async () => true })).message).toBe("no soundcard port named uhf");
  });
});
