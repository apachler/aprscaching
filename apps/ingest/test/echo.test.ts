// SPDX-License-Identifier: AGPL-3.0-or-later
// One ingest box remembers every frame it transmits on any port, so its own signal heard on another of its ports
// (a KISS TNC's radio heard by a soundcard port's receiver, or the reverse) is dropped there too: a box's
// receiving site never attests what the box itself sent.
import { describe, it, expect, afterEach } from "vitest";
import net from "node:net";
import { encodeAx25, kissWrap, modulateAfsk1200 } from "@aprscaching/aprs";
import type { Packet } from "@aprscaching/shared";
import { KissTnc } from "../src/kiss.js";
import { SoundcardPort, type SoundcardConfig } from "../src/soundcard.js";
import { SentFrames } from "../src/echo.js";
import { fakeSpawner, recordingPtt } from "./fakeaudio.js";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});
const until = async (cond: () => boolean, ms = 3000) => {
  const t0 = Date.now();
  while (!cond() && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 10));
};

const cfg: SoundcardConfig = {
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
};
const frame = { src: "OE8APR-10", dst: "APZACG", path: ["WIDE1-1"], payload: ">beacon" };
const other = { ...frame, src: "OE3XYZ-9", payload: ">another station" };
const afsk = (f: typeof frame) =>
  Buffer.from(
    new Int16Array(modulateAfsk1200(encodeAx25(f), 48000, { flags: 40 }).map((v) => Math.round(v * 16000))).buffer,
  );

/** A KISS TNC on a local socket: records what the box writes, and plays frames its radio hears. */
async function fakeTnc() {
  const writes: Buffer[] = [];
  let sock: net.Socket | null = null;
  const server = net.createServer((s) => {
    sock = s;
    s.on("error", () => {});
    s.on("data", (b) => writes.push(b));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  cleanups.push(() => {
    sock?.destroy();
    server.close();
  });
  return {
    port: (server.address() as net.AddressInfo).port,
    writes,
    hear: (f: typeof frame) => sock!.write(kissWrap(encodeAx25(f))),
    connected: () => sock !== null,
  };
}

async function box() {
  const sent = new SentFrames();
  const tnc = await fakeTnc();
  const kissHeard: Packet[] = [];
  const kiss = new KissTnc(
    { host: "127.0.0.1", port: tnc.port, siteCall: "OE8APR-10", sent },
    { onPacket: (p) => kissHeard.push(p) },
  );
  kiss.start();
  cleanups.push(() => kiss["sock"]?.destroy());
  await until(() => tnc.connected() && kiss["connected"]);
  const audio = fakeSpawner();
  const scHeard: Packet[] = [];
  const ptt = recordingPtt();
  const sc = new SoundcardPort(
    cfg,
    { onPacket: (p) => scHeard.push(p) },
    { master: () => true, calls: ["OE8APR-10"], refusal: () => null },
    {
      log: () => {},
      error: () => {},
      spawn: audio.spawn,
      openPtt: async () => ptt,
      siteCall: "OE8APR-10",
      stallMs: 1e12,
      sent,
    },
  );
  await sc.start();
  cleanups.push(() => sc.stop());
  const cap = audio.arecord()[0]!;
  cap.feed(Buffer.alloc(960));
  const feed = (b: Buffer) => {
    for (let i = 0; i < b.length; i += 4097) cap.feed(b.subarray(i, i + 4097));
    cap.feed(Buffer.alloc(9600));
  };
  return { kiss, tnc, kissHeard, sc, ptt: ptt as typeof ptt & { events: string[] }, scHeard, feed };
}

describe("one box, one memory of what it sent", () => {
  it("a frame sent on the KISS TNC is not heard back on the soundcard port", async () => {
    const b = await box();
    expect(b.kiss.send(frame)).toBe(true);
    await until(() => b.tnc.writes.length > 0);
    b.feed(afsk(frame));
    expect(b.scHeard).toHaveLength(0);
    b.feed(afsk(other)); // another station is heard as ever
    expect(b.scHeard.map((p) => p.src)).toEqual(["OE3XYZ-9"]);
  });

  it("a frame sent on the soundcard port is not heard back on the KISS TNC", async () => {
    const b = await box();
    expect(b.sc.send(frame)).toBe(true);
    await until(() => b.ptt.events.includes("unkey"));
    b.tnc.hear(frame);
    b.tnc.hear(other);
    await until(() => b.kissHeard.length > 0);
    await new Promise((r) => setTimeout(r, 100));
    expect(b.kissHeard.map((p) => p.src)).toEqual(["OE3XYZ-9"]);
  });
});

describe("SentFrames", () => {
  it("forgets a frame after its echo window", () => {
    let t = 0;
    const sent = new SentFrames(() => t);
    const raw = encodeAx25(frame);
    sent.remember(raw);
    expect(sent.echoes(raw)).toBe(true);
    expect(sent.echoes(encodeAx25(other))).toBe(false);
    t += 31_000;
    expect(sent.echoes(raw)).toBe(false);
  });
});
