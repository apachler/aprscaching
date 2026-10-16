// SPDX-License-Identifier: AGPL-3.0-or-later
// The soundcard port's audio through PulseAudio (SOUNDCARD_AUDIO=pulse): the parec and pacat arguments, the
// setting per port, the operator's hints, the doctor's rows, and a port that captures with parec and transmits
// with pacat, keying until pacat has drained and exited.
import { describe, it, expect, afterEach } from "vitest";
import { audioCommand, audioHint, audioToolsProblem, pulseArgs } from "../src/audioio.js";
import { SoundcardPort, type SoundcardConfig } from "../src/soundcard.js";
import { soundcardPorts } from "../src/soundcardconfig.js";
import { soundcardChecks, type CheckDeps } from "../src/soundcardcheck.js";
import { fakeSpawner, recordingPtt, type FakeChild } from "./fakeaudio.js";

describe("SOUNDCARD_AUDIO", () => {
  it("runs parec and pacat with raw s16le mono at the port's rate, low latency, on a named source and sink", () => {
    const p = { audio: "pulse" as const, device: "OpenSL_ES_source", playback: "OpenSL_ES_sink", rate: 48000 };
    expect(audioCommand(p, "capture")).toEqual({
      cmd: "parec",
      args: [
        "--device=OpenSL_ES_source",
        "--raw",
        "--format=s16le",
        "--channels=1",
        "--rate=48000",
        "--latency-msec=50",
        "--client-name=APRScaching",
        "--stream-name=soundcard capture",
      ],
    });
    const play = audioCommand(p, "playback");
    expect(play.cmd).toBe("pacat");
    expect(play.args.slice(0, 2)).toEqual(["--playback", "--device=OpenSL_ES_sink"]);
    expect(play.args).toContain("--latency-msec=100");
    expect(pulseArgs("default", 44100, "capture")).not.toContainEqual(expect.stringMatching(/^--device/));
    expect(audioCommand({ device: "plughw:1,0", playback: "plughw:1,0", rate: 48000 }, "capture").cmd).toBe("arecord");
  });

  it("is read per port, and a further port inherits it", () => {
    const ports = soundcardPorts({
      SOUNDCARD_DEVICE: "default",
      SOUNDCARD_AUDIO: "pulse",
      SOUNDCARD_PORTS: JSON.stringify([{ device: "src2" }, { device: "plughw:1,0", audio: "alsa" }]),
    });
    expect(ports.map((p) => p.audio ?? "alsa")).toEqual(["pulse", "pulse", "alsa"]);
    expect(soundcardPorts({ SOUNDCARD_DEVICE: "plughw:1,0" })[0]!.audio).toBeUndefined();
    expect(() => soundcardPorts({ SOUNDCARD_DEVICE: "x", SOUNDCARD_AUDIO: "jack" })).toThrow(
      /SOUNDCARD_AUDIO: expected alsa, pulse/,
    );
    expect(() => soundcardPorts({ SOUNDCARD_PORTS: JSON.stringify([{ device: "x", audio: "oss" }]) })).toThrow(
      /SOUNDCARD_PORTS\[0\]\.audio/,
    );
  });

  it("gives a termux-usb PTT the port's watchdog plus a margin", () => {
    const [p] = soundcardPorts({
      SOUNDCARD_DEVICE: "default",
      SOUNDCARD_AUDIO: "pulse",
      SOUNDCARD_TX: "1",
      SOUNDCARD_PTT: "termux-usb:auto:cm108",
      SOUNDCARD_PTT_MAX_MS: "8000",
    });
    expect(p!.ptt).toEqual({ kind: "termux-usb", device: "auto", method: "cm108", gpio: 3, maxKeyMs: 10_000 });
  });

  it("names the fix for PulseAudio's failures", () => {
    const enoent = Object.assign(new Error("spawn parec ENOENT"), { code: "ENOENT" });
    expect(audioHint("parec", enoent, "")).toMatch(
      /parec not found: install PulseAudio \(Termux: pkg install pulseaudio/,
    );
    expect(audioHint("pacat", null, "Connection failure: Connection refused\n")).toMatch(/start PulseAudio/);
    expect(audioHint("parec", null, "Stream error: No such entity\n")).toMatch(/pactl list short sources/);
    expect(audioHint("aplay", enoent, "")).toMatch(/install ALSA's tools/);
    expect(audioToolsProblem("pulse", () => ({}))).toBeNull();
    expect(audioToolsProblem("pulse", () => ({ error: enoent }))).toMatch(/parec not found/);
  });
});

describe("soundcard doctor checks with PulseAudio", () => {
  const env = { SOUNDCARD_DEVICE: "default", SOUNDCARD_AUDIO: "pulse", BOX_CALL: "OE8APR-10" };
  const deps = (spawnSync: CheckDeps["spawnSync"]): CheckDeps => ({
    gate: async (calls) => new Map(calls.map((c) => [c, { ok: true }])),
    spawnSync,
  });

  it("passes a capture that runs until the check stops it, and a playback that drains", async () => {
    const calls: string[][] = [];
    const rows = await soundcardChecks(
      env,
      deps((cmd, args) => {
        calls.push([cmd, ...args]);
        if (args[0] === "--version") return { status: 0 };
        if (cmd === "parec")
          return { status: null, error: Object.assign(new Error("ETIMEDOUT"), { code: "ETIMEDOUT" }) };
        return { status: 0, stderr: "" };
      }),
    );
    expect(rows.map((r) => `${r.kind}:${r.status}`).slice(0, 2)).toEqual(["pulse:pass", "audio:pass"]);
    expect(rows[0]!.message).toBe("parec and pacat are installed");
    expect(calls.find((c) => c[0] === "parec" && c[1] !== "--version")?.at(-1)).toBe("/dev/null");
    expect(calls.some((c) => c[0] === "pacat" && c[1] === "--playback")).toBe(true);
  });

  it("fails a server that is not running, naming the fix", async () => {
    const rows = await soundcardChecks(
      env,
      deps((_cmd, args) =>
        args[0] === "--version" ? { status: 0 } : { status: 1, stderr: "Connection failure: Connection refused" },
      ),
    );
    expect(rows[1]).toMatchObject({ kind: "audio", status: "fail" });
    expect(rows[1]!.message).toMatch(/start PulseAudio/);
    expect(rows[1]!.fix).toMatch(/pactl list short sources/);
  });
});

describe("a soundcard port on PulseAudio", () => {
  const ports: SoundcardPort[] = [];
  afterEach(async () => {
    for (const p of ports.splice(0)) await p.stop();
  });

  it("captures with parec, plays with pacat, and unkeys only after pacat has drained and exited", async () => {
    const audio = fakeSpawner({ aplay: "hang" }); // pacat exits when the test says its stream drained
    const ptt = recordingPtt();
    const cfg: SoundcardConfig = {
      name: "1",
      device: "default",
      playback: "default",
      audio: "pulse",
      rate: 48000,
      tx: true,
      ptt: { kind: "none" },
      txDelayMs: 100,
      txTailMs: 0,
      persist: 255,
      slotTimeMs: 10,
      pttMaxMs: 10_000,
      txLevel: 0.5,
      dutyPct: 100,
    };
    const port = new SoundcardPort(
      cfg,
      { onPacket: () => {} },
      { master: () => true, calls: ["OE8APR-10"], refusal: () => null },
      { log: () => {}, error: () => {}, spawn: audio.spawn, openPtt: async () => ptt, stallMs: 1e12 },
    );
    ports.push(port);
    await port.start();
    const cap = audio.arecord()[0]!;
    expect(cap.cmd).toBe("parec");
    cap.feed(Buffer.alloc(960));
    expect(port.send({ src: "OE8APR-10", dst: "APZACG", payload: ">pulse" })).toBe(true);
    const until = async (cond: () => boolean) => {
      for (let i = 0; i < 600 && !cond(); i++) await new Promise((r) => setTimeout(r, 5));
    };
    await until(() => audio.aplay().length > 0 && audio.aplay()[0]!.written.length > 0);
    const player = audio.aplay()[0]! as FakeChild;
    expect(player.cmd).toBe("pacat");
    expect(ptt.events).toEqual(["key"]);
    await new Promise((r) => setTimeout(r, 30));
    expect(ptt.events).toEqual(["key"]); // still keyed while pacat drains
    player.exit(0);
    await until(() => ptt.events.length > 1);
    expect(ptt.events).toEqual(["key", "unkey"]);
    expect(Buffer.concat(player.written).length).toBeGreaterThan(48000 * 2 * 0.1); // at least the TXDELAY
  });
});
