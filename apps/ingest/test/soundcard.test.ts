// SPDX-License-Identifier: AGPL-3.0-or-later
// The soundcard port with fake arecord/aplay processes and a recording PTT: a frame one port transmits is
// heard by another, the transmit gate refuses what it must, CSMA holds back on a busy channel, and the PTT
// watchdog releases a stuck transmitter and faults the port.
import { describe, it, expect, afterEach } from "vitest";
import { modulateAfsk1200, encodeAx25 } from "@aprscaching/aprs";
import type { Packet } from "@aprscaching/shared";
import { SoundcardPort, txDelayFlags, type SoundcardConfig, type SoundcardGate } from "../src/soundcard.js";
import { fakeSpawner, recordingPtt } from "./fakeaudio.js";

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
  ...o,
});
const openGate = (o: Partial<SoundcardGate> = {}): SoundcardGate => ({
  master: () => true,
  calls: ["OE8APR-10"],
  unverified: () => null,
  ...o,
});
const until = async (cond: () => boolean, ms = 3000) => {
  const t0 = Date.now();
  while (!cond() && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 5));
};
const quiet = { log: () => {}, error: () => {} };

const ports: SoundcardPort[] = [];
afterEach(async () => {
  for (const p of ports.splice(0)) await p.stop();
});

async function makePort(
  o: { cfg?: Partial<SoundcardConfig>; gate?: Partial<SoundcardGate>; aplayHangs?: boolean; siteCall?: string } = {},
  extra: { random?: () => number; sleep?: (ms: number) => Promise<void>; error?: (m: string) => void } = {},
) {
  const audio = fakeSpawner({ aplayHangs: o.aplayHangs });
  const ptt = recordingPtt();
  const packets: Packet[] = [];
  const port = new SoundcardPort(cfg(o.cfg), { onPacket: (p) => packets.push(p) }, openGate(o.gate), {
    ...quiet,
    spawn: audio.spawn,
    openPtt: async () => ptt,
    siteCall: o.siteCall,
    ...extra,
  });
  ports.push(port);
  await port.start();
  return { port, audio, ptt, packets };
}

const frame = { src: "OE8APR-10", dst: "APZACG", path: ["WIDE1-1"], payload: ">soundcard loopback" };

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
    const audio = Buffer.concat(tx.audio.aplay()[0]!.written);
    // the captured stream arrives in odd-sized chunks, as a pipe delivers it
    const cap = rx.audio.arecord()[0]!;
    for (let i = 0; i < audio.length; i += 4097) cap.feed(audio.subarray(i, i + 4097));
    cap.feed(Buffer.alloc(9600)); // a little silence after it
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
      const audio = fakeSpawner();
      const port = new SoundcardPort(cfg({ tx: false }), { onPacket: () => {} }, openGate(), {
        ...quiet,
        spawn: audio.spawn,
        openPtt: async () => {
          opened = true;
          return recordingPtt();
        },
      });
      ports.push(port);
      await port.start();
      expect(opened).toBe(false);
      expect(port.txRefusal()).toMatch(/SOUNDCARD_TX=1/);
      expect(port.send(frame)).toBe(false);
      expect(audio.aplay()).toHaveLength(0);
    });

    it("refuses while a station call is not control-verified", async () => {
      const { port, ptt, audio } = await makePort({ gate: { unverified: (c) => c[0]! } });
      expect(port.txRefusal()).toBe("verify OE8APR-10 to transmit — control-verification required");
      expect(port.send(frame)).toBe(false);
      await new Promise((r) => setTimeout(r, 20));
      expect(ptt.events).toEqual([]);
      expect(audio.aplay()).toHaveLength(0);
    });

    it("refuses with no station call, and when the box's transmit switch is off", async () => {
      expect((await makePort({ gate: { calls: [] } })).port.send(frame)).toBe(false);
      const { port } = await makePort({ gate: { master: () => false } });
      expect(port.txRefusal()).toBe("transmit is switched off on this box");
      expect(port.send(frame)).toBe(false);
    });

    it("refuses when the PTT cannot open, and keeps receiving", async () => {
      const audio = fakeSpawner();
      const port = new SoundcardPort(cfg(), { onPacket: () => {} }, openGate(), {
        ...quiet,
        spawn: audio.spawn,
        openPtt: async () => {
          throw new Error("no write access to /dev/hidraw0");
        },
      });
      ports.push(port);
      await port.start();
      expect(port.txRefusal()).toMatch(/PTT none \(VOX\) unavailable: no write access/);
      expect(port.send(frame)).toBe(false);
      expect(audio.arecord()).toHaveLength(1);
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
      await new Promise((r) => setTimeout(r, 30));
      expect(ptt.events).toEqual([]);
    });
  });

  describe("channel access", () => {
    it("holds a frame back while the channel is busy, then sends once it clears", async () => {
      let slots = 0;
      const ref: { port?: SoundcardPort } = {};
      const signal = modulateAfsk1200(encodeAx25({ ...frame, payload: ">someone else talking" }), 48000, { flags: 60 });
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
        {
          random: () => draws.shift() ?? 0,
          sleep: async (ms) => void (ms === 10 && slots++),
        },
      );
      expect(port.send(frame)).toBe(true);
      await until(() => ptt.events.includes("unkey"));
      expect(slots).toBe(2);
    });
  });

  describe("PTT watchdog", () => {
    it("releases a stuck transmitter, kills the playback and faults the port", async () => {
      const errors: string[] = [];
      const { port, ptt, audio } = await makePort(
        { aplayHangs: true, cfg: { pttMaxMs: 1200 } },
        { error: (m) => errors.push(m) },
      );
      expect(port.send(frame)).toBe(true);
      await until(() => port.fault !== null, 4000);
      expect(port.fault).toMatch(/keyed longer than 1200 ms/);
      await until(() => ptt.events.filter((e) => e === "unkey").length >= 1);
      expect(ptt.events.slice(0, 3)).toEqual(["key", "releaseSync", "unkey"]);
      expect(audio.aplay()[0]!.killed).toContain("SIGKILL");
      expect(errors.some((e) => /FAULT/.test(e))).toBe(true);
      expect(port.label()).toBe("soundcard 1 (fault: PTT watchdog)");
      // the port stays off the air
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

  it("names a missing arecord with the package to install", async () => {
    const errors: string[] = [];
    const { audio } = await makePort({}, { error: (m) => errors.push(m) });
    const cap = audio.arecord()[0]!;
    cap.emit("error", Object.assign(new Error("spawn arecord ENOENT"), { code: "ENOENT" }));
    cap.exit(-2);
    expect(errors[0]).toMatch(/arecord not found: install ALSA's tools \(apt install alsa-utils\)/);
  });
});
