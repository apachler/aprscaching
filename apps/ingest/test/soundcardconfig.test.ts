// SPDX-License-Identifier: AGPL-3.0-or-later
// The soundcard settings, the call gate every transmit port shares (fresh answers, fail-closed, the gateway's
// MAC), and the doctor's checks and PTT test, all against fakes.
import { describe, it, expect, vi } from "vitest";
import { createHmac } from "node:crypto";
import { encodeAx25, modulateAfsk1200 } from "@aprscaching/aprs";
import { validateConfig } from "@aprscaching/shared";
import { soundcardPorts } from "../src/soundcardconfig.js";
import {
  CallVerifier,
  TxGateRefused,
  TxGateUnsupported,
  boxTransmits,
  gateCheck,
  gatewayTxGateLookup,
  stationCalls,
  txGateGraceMs,
  type TxGateLookup,
} from "../src/callverify.js";
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
        dutyPct: 20,
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

describe("the call gate", () => {
  const answers = (m: Record<string, { ok: boolean; reason?: string }>) => new Map(Object.entries(m));

  it("lists every call the box transmits under, once", () => {
    expect(
      stationCalls({ DIGI_CALL: "oe8apr-10", IGATE_CALL: "OE8APR-10", NETROM_CALL: "OE8APR-5" }, "OE8APR-11"),
    ).toEqual(["OE8APR-11", "OE8APR-10", "OE8APR-5"]);
  });

  it("opens only for calls the gateway confirmed, says why otherwise", async () => {
    const v = new CallVerifier(async () =>
      answers({
        "OE8APR-10": { ok: true },
        "DL1ABC-1": { ok: false, reason: "not control-verified" },
        "OE3OTH-1": { ok: false, reason: "not held by this box's operator" },
      }),
    );
    expect(v.refusal(["OE8APR-10"])).toMatch(/has not confirmed OE8APR-10/); // nothing asked yet
    await v.refresh(["OE8APR-10", "DL1ABC-1", "OE3OTH-1"]);
    expect(v.refusal(["OE8APR-10"])).toBeNull();
    expect(v.refusal(["OE8APR-10", "DL1ABC-1"])).toBe("verify DL1ABC-1 to transmit — control-verification required");
    expect(v.refusal(["OE3OTH-1"])).toBe("OE3OTH-1 cannot transmit from this box: not held by this box's operator");
    expect(v.refusal([])).toMatch(/no station call is set/);
  });

  it("a stale answer fails closed: two intervals without a fresh answer close the gate", async () => {
    let clock = 0;
    let up = true;
    const v = new CallVerifier(
      async () => {
        if (!up) throw new Error("unreachable");
        return answers({ "OE8APR-10": { ok: true } });
      },
      { intervalMs: 180_000, now: () => clock },
    );
    await v.refresh(["OE8APR-10"]);
    up = false;
    clock += 300_000;
    await v.refresh(["OE8APR-10"]); // the gateway is down: the old answer is kept, but ages
    expect(v.refusal(["OE8APR-10"])).toBeNull();
    clock += 61_000; // past two intervals since the last answer
    expect(v.refusal(["OE8APR-10"])).toBe("the gateway has not confirmed OE8APR-10 recently (unreachable)");
  });

  it("a revoked verification closes the gate at the next refresh", async () => {
    let verified = true;
    const v = new CallVerifier(async () =>
      answers({ "OE8APR-10": verified ? { ok: true } : { ok: false, reason: "not control-verified" } }),
    );
    await v.refresh(["OE8APR-10"]);
    expect(v.refusal(["OE8APR-10"])).toBeNull();
    verified = false;
    await v.refresh(["OE8APR-10"]);
    expect(v.refusal(["OE8APR-10"])).toMatch(/^verify OE8APR-10/);
  });

  it("a gateway without /ingest/txgate counts as unreachable: logged once, retried with backoff", async () => {
    vi.useFakeTimers();
    try {
      const asked: number[] = [];
      const logs: string[] = [];
      const v = new CallVerifier(
        async () => {
          asked.push(Date.now());
          throw new TxGateUnsupported("the gateway has no /ingest/txgate (HTTP 404)");
        },
        { intervalMs: 180_000, retryMs: 30_000, log: (m) => logs.push(m) },
      );
      const t0 = Date.now();
      v.start(["OE8APR-10"]);
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(400_000);
      v.stop();
      expect(asked.map((t) => t - t0)).toEqual([0, 30_000, 90_000, 210_000, 390_000]);
      expect(logs).toEqual([
        "[txgate] the gateway has no /ingest/txgate (HTTP 404); transmit stays off until the gateway is updated",
      ]);
      expect(v.refusal(["OE8APR-10"])).toMatch(/has not confirmed/);
    } finally {
      vi.useRealTimers();
    }
  });

  describe("TX_GATE_GRACE", () => {
    const answers = (m: Record<string, { ok: boolean; reason?: string }>) => new Map(Object.entries(m));
    /** A verifier on a fake clock whose gateway answers `state`: ok, not verified, or unreachable. */
    const gate = (graceMs: number) => {
      const t = { clock: 0, state: "ok" as "ok" | "revoked" | "down" | "404" | "401" };
      const v = new CallVerifier(
        async () => {
          if (t.state === "down") throw new Error("connect ETIMEDOUT");
          if (t.state === "404") throw new TxGateUnsupported("the gateway has no /ingest/txgate (HTTP 404)");
          if (t.state === "401") throw new TxGateRefused("the gateway refused this box's credential (HTTP 401)");
          return answers({
            "OE8APR-10": t.state === "ok" ? { ok: true } : { ok: false, reason: "not control-verified" },
          });
        },
        { graceMs, now: () => t.clock },
      );
      return { v, t };
    };

    it("parses minutes and units, defaults to 6 minutes and clamps to 6 minutes to 24 hours", () => {
      const warned: string[] = [];
      const w = (m: string) => warned.push(m);
      expect(txGateGraceMs(undefined, w)).toBe(6 * 60_000);
      expect(txGateGraceMs("", w)).toBe(6 * 60_000);
      expect(txGateGraceMs("30", w)).toBe(30 * 60_000);
      expect(txGateGraceMs("45m", w)).toBe(45 * 60_000);
      expect(txGateGraceMs("2h", w)).toBe(120 * 60_000);
      expect(warned).toEqual([]);
      expect(txGateGraceMs("1", w)).toBe(6 * 60_000);
      expect(txGateGraceMs("48h", w)).toBe(24 * 60 * 60_000);
      expect(warned).toHaveLength(2);
      expect(() => txGateGraceMs("soon", w)).toThrow(/TX_GATE_GRACE: expected minutes/);
      expect(() => txGateGraceMs("2d", w)).toThrow(/TX_GATE_GRACE/);
    });

    it("an unreachable gateway within the grace keeps a confirmed call open", async () => {
      const { v, t } = gate(60 * 60_000);
      await v.refresh(["OE8APR-10"]);
      t.state = "down";
      t.clock += 59 * 60_000;
      await v.refresh(["OE8APR-10"]);
      expect(v.refusal(["OE8APR-10"])).toBeNull();
      t.state = "404"; // a gateway without the endpoint counts as unreachable too
      await v.refresh(["OE8APR-10"]);
      expect(v.refusal(["OE8APR-10"])).toBeNull();
    });

    it("past the grace the gate closes, and opens again once the gateway confirms", async () => {
      const { v, t } = gate(60 * 60_000);
      await v.refresh(["OE8APR-10"]);
      t.state = "down";
      t.clock += 60 * 60_000 + 1;
      await v.refresh(["OE8APR-10"]);
      expect(v.refusal(["OE8APR-10"])).toBe("the gateway has not confirmed OE8APR-10 recently (connect ETIMEDOUT)");
      t.state = "ok";
      await v.refresh(["OE8APR-10"]);
      expect(v.refusal(["OE8APR-10"])).toBeNull();
    });

    it("a 'not verified' answer closes the gate at once, even within a long grace", async () => {
      const { v, t } = gate(24 * 60 * 60_000);
      await v.refresh(["OE8APR-10"]);
      t.clock += 60_000;
      t.state = "revoked";
      await v.refresh(["OE8APR-10"]);
      expect(v.refusal(["OE8APR-10"])).toMatch(/^verify OE8APR-10 to transmit/);
      // and the gateway going away afterwards does not reopen it
      t.state = "down";
      await v.refresh(["OE8APR-10"]);
      expect(v.refusal(["OE8APR-10"])).toMatch(/^verify OE8APR-10 to transmit/);
    });

    it("a refused credential closes the gate at once, whatever the grace", async () => {
      const { v, t } = gate(24 * 60 * 60_000);
      await v.refresh(["OE8APR-10"]);
      t.state = "401";
      await v.refresh(["OE8APR-10"]);
      expect(v.refusal(["OE8APR-10"])).toMatch(/refused this box's credential/);
    });
  });

  it("a receive-only box does not ask at all", () => {
    expect(boxTransmits({ KISS_TNC_HOST: "tnc", IGATE_CALL: "OE8APR-10", IGATE_PASS: "1" }, false)).toBe(false);
    expect(boxTransmits({ KISS_TNC_HOST: "tnc", IGATE_TX: "1" }, false)).toBe(true);
    expect(boxTransmits({ KISS_TNC_HOST: "tnc", DIGI_CALL: "OE8APR-10" }, false)).toBe(true);
    expect(boxTransmits({ DIGI_CALL: "OE8APR-10" }, false)).toBe(false); // no transmitting port
    expect(boxTransmits({}, true)).toBe(true); // a soundcard port with transmit on
  });

  it("refreshes every interval, and retries from 30 s with backoff while the gateway is down", async () => {
    vi.useFakeTimers();
    try {
      let up = false;
      const asked: number[] = [];
      const v = new CallVerifier(
        async () => {
          asked.push(Date.now());
          if (!up) throw new Error("down");
          return answers({ "OE8APR-10": { ok: true } });
        },
        { intervalMs: 180_000, retryMs: 30_000 },
      );
      const t0 = Date.now();
      v.start(["OE8APR-10"]);
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(30_000);
      await vi.advanceTimersByTimeAsync(60_000);
      up = true;
      await vi.advanceTimersByTimeAsync(120_000);
      await vi.advanceTimersByTimeAsync(180_000);
      v.stop();
      expect(asked.map((t) => t - t0)).toEqual([0, 30_000, 90_000, 210_000, 390_000]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("the KISS check refuses with the switch off or a refused call, and logs each reason once", async () => {
    const v = new CallVerifier(async () => answers({ "OE8APR-10": { ok: true } }));
    const logged: string[] = [];
    let master = true;
    const open = gateCheck(
      v,
      ["OE8APR-10"],
      () => master,
      (m) => logged.push(m),
    );
    expect(open()).toBe(false);
    expect(open()).toBe(false);
    await v.refresh(["OE8APR-10"]);
    expect(open()).toBe(true);
    master = false;
    expect(open()).toBe(false);
    expect(logged).toEqual([
      "transmit refused: the gateway has not confirmed OE8APR-10 recently",
      "transmit refused: transmit is switched off on this box",
    ]);
  });
});

describe("the gateway lookup", () => {
  const SECRET = "the-ingest-secret-123";
  /** A gateway stand-in: answers `body`, with the MAC over the box's nonce unless `mac` replaces it. */
  const gateway = (body: string, o: { mac?: string } = {}) => {
    const urls: URL[] = [];
    const f = (async (u: string) => {
      const url = new URL(u);
      urls.push(url);
      const nonce = url.searchParams.get("nonce")!;
      const mac = o.mac ?? createHmac("sha256", SECRET).update(`${nonce}\n${body}`).digest("hex");
      return new Response(body, { headers: { "x-txgate-mac": mac } });
    }) as typeof fetch;
    return { f, urls };
  };
  const body = JSON.stringify({
    calls: { "OE8APR-10": { ok: true }, DL1ABC: { ok: false, reason: "not control-verified" } },
  });

  it("asks /ingest/txgate with the calls, a fresh nonce and the box id, and checks the MAC", async () => {
    const g = gateway(body);
    const lookup = gatewayTxGateLookup({
      ingestUrl: "http://gw:8080/ingest",
      secret: SECRET,
      boxKey: false,
      boxId: "shack-1",
      fetch: g.f,
    });
    const got = await lookup(["OE8APR-10", "DL1ABC"]);
    expect(got.get("OE8APR-10")).toEqual({ ok: true, reason: undefined });
    expect(got.get("DL1ABC")?.ok).toBe(false);
    const u = g.urls[0]!;
    expect(u.pathname).toBe("/ingest/txgate");
    expect(u.searchParams.get("calls")).toBe("OE8APR-10,DL1ABC");
    expect(u.searchParams.get("box")).toBe("shack-1");
    expect(u.searchParams.get("nonce")!.length).toBeGreaterThanOrEqual(16);
    await lookup(["OE8APR-10"]);
    expect(g.urls[1]!.searchParams.get("nonce")).not.toBe(u.searchParams.get("nonce"));
  });

  it("refuses an answer without a valid MAC: a forged 'ok' on a plain-http hop does not open the gate", async () => {
    const forged = gateway(JSON.stringify({ calls: { "OE8APR-10": { ok: true } } }), { mac: "00".repeat(32) });
    const lookup = gatewayTxGateLookup({
      ingestUrl: "http://gw/ingest",
      secret: SECRET,
      boxKey: false,
      fetch: forged.f,
    });
    await expect(lookup(["OE8APR-10"])).rejects.toThrow(/valid MAC/);
    const v = new CallVerifier(lookup);
    await v.refresh(["OE8APR-10"]);
    expect(v.refusal(["OE8APR-10"])).toMatch(/has not confirmed/);
  });

  it("names an older gateway's 404 as unsupported", async () => {
    const lookup = gatewayTxGateLookup({
      ingestUrl: "http://gw/ingest",
      secret: SECRET,
      boxKey: false,
      fetch: (async () => new Response("not found", { status: 404 })) as typeof fetch,
    });
    await expect(lookup(["OE8APR-10"])).rejects.toBeInstanceOf(TxGateUnsupported);
  });

  it("an enrolled box takes the answer only over https or loopback", async () => {
    const g = gateway(body);
    const remote = gatewayTxGateLookup({ ingestUrl: "http://gw.example/ingest", secret: "", boxKey: true, fetch: g.f });
    await expect(remote(["OE8APR-10"])).rejects.toThrow(/only over https/);
    expect(g.urls).toHaveLength(0);
    for (const ingestUrl of ["https://gw.example/ingest", "http://127.0.0.1:8787/ingest"]) {
      const ok = gatewayTxGateLookup({ ingestUrl, secret: "", boxKey: true, fetch: g.f });
      expect((await ok(["OE8APR-10"])).get("OE8APR-10")?.ok).toBe(true);
    }
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
  const allOk: TxGateLookup = async (calls) => new Map(calls.map((c) => [c, { ok: true }]));
  const deps = (o: Partial<CheckDeps> = {}): CheckDeps => ({ gate: allOk, spawnSync: alsa(), ...o });
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
    expect(rows[4]!.message).toMatch(/the gateway confirms OE8APR-10 for this box/);
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

  it("warns about a refused call and a long watchdog, and fails an unreachable rigctld", async () => {
    const rows = await soundcardChecks(
      { ...env, SOUNDCARD_PTT: "rigctld", SOUNDCARD_PTT_MAX_MS: "30000" },
      deps({
        gate: async (calls) => new Map(calls.map((c) => [c, { ok: false, reason: "not held by this box's operator" }])),
        tcpOpen: async () => false,
      }),
    );
    expect(rows.filter((r) => r.status !== "pass").map((r) => `${r.kind}:${r.status}`)).toEqual([
      "ptt:fail",
      "tx:warn",
      "tx:warn",
    ]);
    expect(rows.find((r) => r.kind === "tx" && /not held by this box's operator/.test(r.message))).toBeTruthy();
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
  const allOk: TxGateLookup = async (calls) => new Map(calls.map((c) => [c, { ok: true }]));
  /** A second of capture: silence, another station transmitting, or a card the running ingest holds. */
  const listen = (what: "silence" | "busy-channel" | "card-in-use") => (_d: string, rate: number) => {
    if (what === "card-in-use")
      return { status: 1, stdout: Buffer.alloc(0), stderr: "arecord: audio open error: Device or resource busy" };
    if (what === "silence") return { status: 0, stdout: Buffer.alloc(rate * 2), stderr: "" };
    const pcm = modulateAfsk1200(encodeAx25({ src: "OE3XYZ", dst: "APRS", payload: ">talking" }), rate, { flags: 100 });
    return { status: 0, stdout: Buffer.from(new Int16Array(pcm.map((v) => Math.round(v * 16000))).buffer), stderr: "" };
  };

  it("is refused with transmit off", async () => {
    const ptt = recordingPtt();
    const r = await pttTest({ ...env, SOUNDCARD_TX: "" }, undefined, { gate: allOk, openPtt: async () => ptt });
    expect(r).toEqual({ ok: false, message: "refused: transmit is off on port 1 (set SOUNDCARD_TX=1)" });
    expect(ptt.events).toEqual([]);
  });

  it("is refused while a call is not confirmed, or the gateway cannot say", async () => {
    const ptt = recordingPtt();
    const no = await pttTest(env, "1", {
      gate: async () => new Map([["OE8APR-10", { ok: false, reason: "not control-verified" }]]),
      openPtt: async () => ptt,
    });
    expect(no.message).toBe("refused: verify OE8APR-10 to transmit — control-verification required");
    const down = await pttTest(env, "1", {
      gate: async () => {
        throw new Error("down");
      },
      openPtt: async () => ptt,
    });
    expect(down.ok).toBe(false);
    expect(ptt.events).toEqual([]);
  });

  it("is refused while the running ingest holds the card, and on a busy channel", async () => {
    const ptt = recordingPtt();
    const held = await pttTest(env, "1", { gate: allOk, openPtt: async () => ptt, listen: listen("card-in-use") });
    expect(held.message).toMatch(/stop the ingest first/);
    const busy = await pttTest(env, "1", { gate: allOk, openPtt: async () => ptt, listen: listen("busy-channel") });
    expect(busy.message).toMatch(/the channel is busy/);
    expect(ptt.events).toEqual([]);
  });

  it("keys under a second on a clear channel and always releases", async () => {
    const ptt = recordingPtt();
    const slept: number[] = [];
    const r = await pttTest(
      env,
      undefined,
      { gate: allOk, openPtt: async () => ptt, listen: listen("silence"), sleep: async (ms) => void slept.push(ms) },
      5000,
    );
    expect(r.ok).toBe(true);
    expect(slept).toEqual([900]);
    expect(ptt.events).toEqual(["key", "unkey", "unkey", "close"]);
  });

  it("names a port that does not exist", async () => {
    expect((await pttTest(env, "uhf", { gate: allOk })).message).toBe("no soundcard port named uhf");
  });
});
