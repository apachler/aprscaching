// SPDX-License-Identifier: AGPL-3.0-or-later
// The soundcard port with fake arecord/aplay processes and a recording PTT (or the real GPIO driver over a fake
// gpioset): a frame one port transmits is heard by another but never by the port itself, the transmit gate
// refuses what it must, CSMA, the frame age limit and the duty cycle hold back, the PTT watchdog releases a stuck
// transmitter, a stop or a SIGTERM during a transmission ends at the unkeyed level, and capture failures stop
// transmit until capture runs again.
import { describe, it, expect, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { modulateAfsk1200, encodeAx25 } from "@aprscaching/aprs";
import type { Packet } from "@aprscaching/shared";
import {
  SoundcardPort,
  txDelayFlags,
  RX_GUARD_MS,
  type SoundcardConfig,
  type SoundcardDeps,
  type SoundcardGate,
} from "../src/soundcard.js";
import { openGpioPtt } from "../src/ptt/gpio.js";
import { forgetPtt, installPttRelease } from "../src/ptt/release.js";
import type { Ptt } from "../src/ptt/index.js";
import { fakeSpawner, gpiosetSpy, recordingPtt } from "./fakeaudio.js";

const cfg = (o: Partial<SoundcardConfig> = {}): SoundcardConfig => ({
  name: "1",
  device: "plughw:1,0",
  playback: "plughw:1,0",
  rate: 48000,
  tx: true,
  ptt: { kind: "none" },
  txDelayMs: 100,
  txTailMs: 20,
  persist: 255,
  slotTimeMs: 10,
  pttMaxMs: 10_000,
  txLevel: 0.5,
  dutyPct: 100,
  ...o,
});
const openGate = (o: Partial<SoundcardGate> = {}): SoundcardGate => ({
  master: () => true,
  calls: ["OE8APR-10"],
  refusal: () => null,
  ...o,
});
const until = async (cond: () => boolean, ms = 3000) => {
  const t0 = Date.now();
  while (!cond() && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 5));
};
const tick = () => new Promise((r) => setTimeout(r, 30));
const quiet = { log: () => {}, error: () => {} };

const ports: SoundcardPort[] = [];
const ptts: Ptt[] = [];
afterEach(async () => {
  for (const p of ports.splice(0)) await p.stop();
  for (const p of ptts.splice(0)) forgetPtt(p);
});

type Audio = ReturnType<typeof fakeSpawner>;
async function makePort(
  o: {
    cfg?: Partial<SoundcardConfig>;
    gate?: Partial<SoundcardGate>;
    audio?: Audio;
    ptt?: Ptt;
    openPtt?: () => Promise<Ptt>;
    siteCall?: string;
    captureUp?: boolean;
  } = {},
  extra: Partial<SoundcardDeps> = {},
) {
  const audio = o.audio ?? fakeSpawner();
  const ptt = (o.ptt ?? recordingPtt()) as Ptt & { events: string[] };
  const packets: Packet[] = [];
  const port = new SoundcardPort(cfg(o.cfg), { onPacket: (p) => packets.push(p) }, openGate(o.gate), {
    ...quiet,
    spawn: audio.spawn,
    openPtt: o.openPtt ?? (async () => ptt),
    siteCall: o.siteCall,
    stallMs: 1e12, // the fake clocks jump; only the stall test watches for a silent capture
    ...extra,
  });
  ports.push(port);
  await port.start();
  // capture delivers audio: carrier detect works, and the port may transmit
  if (o.captureUp !== false) audio.arecord()[0]!.feed(Buffer.alloc(960));
  return { port, audio, ptt, packets };
}

const frame = { src: "OE8APR-10", dst: "APZACG", path: ["WIDE1-1"], payload: ">soundcard loopback" };
/** Feed `audio` to a capture in odd-sized chunks, as a pipe delivers it, then a little silence. */
const feed = (cap: ReturnType<Audio["arecord"]>[number], audio: Buffer) => {
  for (let i = 0; i < audio.length; i += 4097) cap.feed(audio.subarray(i, i + 4097));
  cap.feed(Buffer.alloc(9600));
};

describe("SoundcardPort", () => {
  it("runs arecord and aplay with raw S16_LE mono at the configured rate and devices", async () => {
    const { port, audio } = await makePort({ cfg: { playback: "plughw:2,0", rate: 44100 } });
    expect(audio.arecord()[0]!.args).toEqual([
      "-q",
      "-D",
      "plughw:1,0",
      "-t",
      "raw",
      "-f",
      "S16_LE",
      "-c",
      "1",
      "-r",
      "44100",
    ]);
    expect(port.send(frame)).toBe(true);
    await until(() => audio.aplay().length > 0);
    expect(audio.aplay()[0]!.args).toContain("plughw:2,0");
  });

  it("loops a transmitted frame back through another port's receiver, as a local RF hearing", async () => {
    const tx = await makePort();
    const rx = await makePort({ siteCall: "OE8APR-10" });
    expect(tx.port.send(frame)).toBe(true);
    await until(() => tx.ptt.events.includes("unkey"));
    expect(tx.ptt.events).toEqual(["key", "unkey"]);
    feed(rx.audio.arecord()[0]!, Buffer.concat(tx.audio.aplay()[0]!.written));
    expect(rx.packets).toHaveLength(1);
    expect(rx.packets[0]).toMatchObject({
      src: "OE8APR-10",
      dst: "APZACG",
      payload: ">soundcard loopback",
      heardVia: "rf",
      port: "soundcard",
      igateCall: "OE8APR-10",
    });
  });

  it("never hears its own transmission: not 150 ms after the unkey, nor its echo within 30 s", async () => {
    let clock = 1_000_000;
    const tx = await makePort({ siteCall: "OE8APR-10" }, { now: () => clock });
    expect(tx.port.send(frame)).toBe(true);
    await until(() => tx.ptt.events.includes("unkey"));
    const own = Buffer.concat(tx.audio.aplay()[0]!.written);
    const cap = tx.audio.arecord()[0]!;
    clock += 150; // the capture buffer delivers the port's own signal after the unkey
    feed(cap, own);
    expect(tx.packets).toHaveLength(0);
    clock += RX_GUARD_MS + 1000; // past the guard, the bytes it sent still mark the echo
    feed(cap, own);
    expect(tx.packets).toHaveLength(0);
    // another station's frame is heard as ever
    const other = modulateAfsk1200(encodeAx25({ ...frame, src: "OE3XYZ-9" }), 48000, { flags: 40 });
    feed(cap, Buffer.from(new Int16Array(other.map((v) => Math.round(v * 16000))).buffer));
    expect(tx.packets.map((p) => p.src)).toEqual(["OE3XYZ-9"]);
    clock += 31_000; // after the echo window the same bytes count as a hearing again
    feed(cap, own);
    expect(tx.packets.map((p) => p.src)).toEqual(["OE3XYZ-9", "OE8APR-10"]);
  });

  it("leads each frame with its TXDELAY of flags", () => {
    expect(txDelayFlags(300)).toBe(45);
    expect(txDelayFlags(1)).toBe(1);
    const plain = modulateAfsk1200(encodeAx25(frame), 48000, { flags: 1 }).length;
    const delayed = modulateAfsk1200(encodeAx25(frame), 48000, { flags: txDelayFlags(300) }).length;
    expect(Math.round(((delayed - plain) / 48000) * 1000)).toBe(293); // 44 more flags, 293 ms
  });

  describe("transmit gate", () => {
    it("refuses with transmit off and never opens or keys a PTT", async () => {
      let opened = false;
      const { port, audio } = await makePort({
        cfg: { tx: false },
        openPtt: async () => {
          opened = true;
          return recordingPtt();
        },
      });
      expect(opened).toBe(false);
      expect(port.txRefusal()).toMatch(/SOUNDCARD_TX=1/);
      expect(port.send(frame)).toBe(false);
      expect(audio.aplay()).toHaveLength(0);
    });

    it("refuses what the call gate refuses", async () => {
      const { port, ptt, audio } = await makePort({
        gate: { refusal: (c) => `verify ${c[0]} to transmit — control-verification required` },
      });
      expect(port.txRefusal()).toBe("verify OE8APR-10 to transmit — control-verification required");
      expect(port.send(frame)).toBe(false);
      await tick();
      expect(ptt.events).toEqual([]);
      expect(audio.aplay()).toHaveLength(0);
    });

    it("gates each frame by the calls it goes out under: a refused receive-only call holds back only its own frames", async () => {
      const refused = new Set(["OE8APR-1"]);
      const { port, audio } = await makePort({
        gate: {
          calls: ["OE8APR-10", "OE8APR-1"],
          fallback: "OE8APR-10",
          refusal: (c) => c.find((x) => refused.has(x)) ?? null,
        },
      });
      expect(port.txRefusal()).toBeNull(); // some call is confirmed: the port is up
      expect(port.send({ ...frame, src: "OE8APR-1" })).toBe(false);
      // a digipeated frame names the digipeater's call as its own hop
      expect(port.send({ ...frame, src: "DL1ABC-7", path: ["OE8APR-10*", "WIDE2-1"] })).toBe(true);
      // a frame that names none of the box's calls goes out under the fallback (the digipeater's call)
      expect(port.send({ ...frame, src: "DL1ABC-7", path: ["WIDE1*"] })).toBe(true);
      refused.add("OE8APR-10");
      expect(port.send({ ...frame, src: "DL1ABC-7", path: ["WIDE1*"] })).toBe(false);
      expect(port.txRefusal()).toBe("OE8APR-10");
      await until(() => audio.aplay().length > 0);
    });

    it("refuses when the box's transmit switch is off", async () => {
      const { port } = await makePort({ gate: { master: () => false } });
      expect(port.txRefusal()).toBe("transmit is switched off on this box");
      expect(port.send(frame)).toBe(false);
    });

    it("refuses when the PTT cannot open, and keeps receiving", async () => {
      const { port, audio } = await makePort({
        openPtt: async () => {
          throw new Error("no write access to /dev/hidraw0");
        },
      });
      expect(port.txRefusal()).toMatch(/PTT none \(VOX\) unavailable: no write access/);
      expect(port.send(frame)).toBe(false);
      expect(audio.arecord()).toHaveLength(1);
    });

    it("refuses while capture has delivered no audio: carrier detect would be blind", async () => {
      const { port } = await makePort({ captureUp: false });
      expect(port.txRefusal()).toMatch(/capture is down/);
      expect(port.send(frame)).toBe(false);
    });

    it("re-checks the gate at the moment of keying", async () => {
      let master = true;
      const draws = [0.99, 0]; // the first slot is lost, the second won
      const { port, ptt } = await makePort(
        { gate: { master: () => master }, cfg: { persist: 0 } },
        {
          sleep: async () => {
            master = false; // a remote "TX off" arrives while the frame waits for the channel
          },
          random: () => draws.shift() ?? 0,
        },
      );
      expect(port.send(frame)).toBe(true);
      await tick();
      expect(ptt.events).toEqual([]);
    });
  });

  describe("channel access", () => {
    it("holds a frame back while the channel is busy, then sends once it clears", async () => {
      let slots = 0;
      const ref: { port?: SoundcardPort } = {};
      const signal = modulateAfsk1200(encodeAx25({ ...frame, payload: ">someone else talking" }), 48000, {
        flags: 60,
      });
      const made = await makePort(
        {},
        {
          sleep: async (ms) => {
            if (ms !== 10) return; // TXTAIL, not a slot
            slots++;
            if (slots === 3) ref.port!.pushPcm(new Float32Array(4800)); // the other station stops
          },
        },
      );
      const port = (ref.port = made.port);
      port.pushPcm(signal.subarray(0, Math.floor(signal.length * 0.6))); // mid-transmission
      expect(port.dcd).toBe(true);
      expect(port.send(frame)).toBe(true);
      await until(() => made.ptt.events.includes("unkey"));
      expect(slots).toBe(3);
      expect(made.ptt.events).toEqual(["key", "unkey"]);
    });

    it("on a clear channel, sends in a slot only with the persistence's probability", async () => {
      const draws = [0.9, 0.8, 0.1]; // 230 and 204 lose against persist 63; 25 wins
      let slots = 0;
      const { port, ptt } = await makePort(
        { cfg: { persist: 63 } },
        { random: () => draws.shift() ?? 0, sleep: async (ms) => void (ms === 10 && slots++) },
      );
      expect(port.send(frame)).toBe(true);
      await until(() => ptt.events.includes("unkey"));
      expect(slots).toBe(2);
    });

    it("drops a frame that waited 30 s for a busy channel", async () => {
      let clock = 5_000_000;
      const errors: string[] = [];
      const made = await makePort(
        {},
        { now: () => clock, sleep: async () => void (clock += 1000), error: (m) => errors.push(m) },
      );
      const signal = modulateAfsk1200(encodeAx25({ ...frame, payload: ">a long one" }), 48000, { flags: 60 });
      made.port.pushPcm(signal.subarray(0, Math.floor(signal.length * 0.6))); // busy, and it stays busy
      expect(made.port.send(frame)).toBe(true);
      await until(() => errors.length > 0);
      expect(errors[0]).toMatch(/waited over 30 s/);
      expect(made.ptt.events).toEqual([]);
    });

    it("keeps to the duty cycle: a frame past the minute's budget waits, and goes once airtime ages out", async () => {
      let clock = 9_000_000;
      const keyedAt: number[] = [];
      const errors: string[] = [];
      const ptt = recordingPtt();
      const key = ptt.key;
      ptt.key = async () => {
        keyedAt.push(clock);
        await key();
      };
      const made = await makePort(
        { cfg: { dutyPct: 1 }, ptt }, // 600 ms of every minute; a frame here takes about 330 ms
        {
          now: () => clock,
          sleep: async (ms) => void (clock += ms === 10 ? 5000 : 0),
          error: (m) => errors.push(m),
        },
      );
      expect(made.port.send(frame)).toBe(true);
      expect(made.port.send({ ...frame, payload: ">second" })).toBe(true);
      // the second waits for the budget past its 30 s age limit, and is dropped
      await until(() => errors.length > 0);
      expect(keyedAt).toHaveLength(1);
      expect(errors[0]).toMatch(/waited over 30 s \(busy channel or duty cycle\)/);
      // a minute after the first, the budget is back
      clock = keyedAt[0]! + 60_001;
      expect(made.port.send({ ...frame, payload: ">third" })).toBe(true);
      await until(() => keyedAt.length === 2);
      expect(keyedAt).toHaveLength(2);
    });
  });

  describe("PTT watchdog", () => {
    it("releases a stuck transmitter, kills the playback and faults the port", async () => {
      const errors: string[] = [];
      const { port, ptt, audio } = await makePort(
        { audio: fakeSpawner({ aplay: "hang" }), cfg: { pttMaxMs: 1200 } },
        { error: (m) => errors.push(m) },
      );
      expect(port.send(frame)).toBe(true);
      await until(() => port.fault !== null, 4000);
      expect(port.fault).toMatch(/keyed longer than 1200 ms/);
      await until(() => ptt.events.includes("unkey"));
      expect(ptt.events.slice(0, 3)).toEqual(["key", "releaseSync", "unkey"]);
      await until(() => audio.aplay()[0]!.killed.length > 0);
      expect(audio.aplay()[0]!.killed).toContain("SIGKILL");
      expect(errors.some((e) => /FAULT/.test(e))).toBe(true);
      expect(port.label()).toBe("soundcard 1 (fault: PTT watchdog)");
      expect(port.send(frame)).toBe(false);
      expect(port.txRefusal()).toMatch(/faulted/);
    });

    it("refuses a frame whose airtime would exceed the watchdog", async () => {
      const errors: string[] = [];
      const { port, ptt } = await makePort(
        { cfg: { pttMaxMs: 1000, txDelayMs: 1000 } },
        { error: (m) => errors.push(m) },
      );
      expect(port.send({ ...frame, payload: ">" + "x".repeat(200) })).toBe(true);
      await until(() => errors.length > 0);
      expect(errors[0]).toMatch(/exceeds the PTT watchdog/);
      expect(ptt.events).toEqual([]);
    });
  });

  describe("stopping while keyed (the real GPIO driver, a fake gpioset)", () => {
    const gpioPort = async () => {
      const g = gpiosetSpy("v2.1");
      const made = await makePort({
        audio: fakeSpawner({ aplay: "hang" }),
        openPtt: async () => {
          const p = await openGpioPtt({ chip: "gpiochip0", line: 17, invert: false }, { ...g, settleMs: 1 });
          ptts.push(p);
          return p;
        },
      });
      expect(made.port.send(frame)).toBe(true);
      await until(() => g.level() === "1");
      expect(g.level()).toBe("1");
      return { ...made, g };
    };

    it("stop() during a transmission ends at the unkeyed level with no keyed holder left", async () => {
      const { port, g } = await gpioPort();
      await port.stop();
      expect(g.level()).toBe("0");
      expect(g.live()).toHaveLength(0);
      expect(g.kids.filter((k) => k.value === "1").every((k) => k.killedWith)).toBe(true);
      // the keyed holder was ended before the line was set unkeyed, and nothing keyed it again
      const keyedKill = g.log.indexOf("kill 1 SIGTERM");
      expect(keyedKill).toBeGreaterThan(-1);
      expect(g.log.slice(keyedKill).some((e) => e === "hold 1")).toBe(false);
      expect(g.log.at(-1)).toBe("once 0");
    });

    it("SIGTERM while keyed unkeys, and the exit release sets the unkeyed level", async () => {
      const proc = new EventEmitter();
      installPttRelease(proc as unknown as NodeJS.Process);
      const { g } = await gpioPort();
      proc.emit("SIGTERM");
      await until(() => g.level() === "0");
      expect(g.level()).toBe("0");
      proc.emit("exit");
      expect(g.live()).toHaveLength(0);
      expect(g.log.at(-1)).toBe("once 0");
    });
  });

  describe("audio process failures", () => {
    it("a playback that fails to spawn ends the transmission and unkeys", async () => {
      const errors: string[] = [];
      const { port, ptt } = await makePort(
        { audio: fakeSpawner({ aplay: "spawn-error" }) },
        { error: (m) => errors.push(m) },
      );
      expect(port.send(frame)).toBe(true);
      await until(() => ptt.events.includes("unkey"));
      expect(ptt.events).toEqual(["key", "unkey"]);
      expect(errors.some((e) => /aplay not found: install ALSA's tools/.test(e))).toBe(true);
    });

    it("a capture that fails to spawn names its package, refuses transmit and restarts", async () => {
      const errors: string[] = [];
      const audio = fakeSpawner({ arecord: "spawn-error" });
      const { port } = await makePort({ audio, captureUp: false }, { error: (m) => errors.push(m) });
      await until(() => errors.length > 0);
      expect(errors[0]).toMatch(/arecord not found: install ALSA's tools \(apt install alsa-utils\)/);
      expect(errors[0]).toMatch(/restarting in \d+ s \(no transmit meanwhile\)/);
      expect(port.txRefusal()).toMatch(/capture is down/);
      await until(() => audio.arecord().length > 1, 4000);
      expect(audio.arecord().length).toBeGreaterThan(1);
    });

    it("a capture that stops delivering audio is restarted, and transmit waits for it", async () => {
      const errors: string[] = [];
      const { port, audio } = await makePort({}, { stallMs: 200, error: (m) => errors.push(m) });
      expect(port.txRefusal()).toBeNull();
      await until(() => errors.some((e) => /no audio/.test(e)), 2000);
      expect(audio.arecord()[0]!.killed).toContain("SIGKILL");
      expect(port.txRefusal()).toMatch(/capture is down/);
    });
  });
});
