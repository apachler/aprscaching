// SPDX-License-Identifier: AGPL-3.0-or-later
// A KISS TNC with several channels (Direwolf with two radios on one KISS port): each listed channel is its own
// port, what the box repeats or answers goes out on the channel that heard it, the timing goes to every listed
// channel, and a frame on a channel the box does not list is ignored.
import { describe, it, expect, afterEach, vi } from "vitest";
import net from "node:net";
import { encodeAx25, kissWrap } from "@aprscaching/aprs";
import type { ParsedFrame } from "@aprscaching/aprs";
import type { Packet } from "@aprscaching/shared";
import { KissTnc, kissChannelsFromEnv } from "../src/kiss.js";
import { Digipeater } from "../src/digipeater.js";
import { Igate } from "../src/igate.js";

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((c) => c()));
const until = async (cond: () => boolean, ms = 3000) => {
  const t0 = Date.now();
  while (!cond() && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 20));
};

/** A KISS data frame on `channel`. */
const onChannel = (channel: number, f: { src: string; dst: string; path?: string[]; payload: string }) => {
  const out = kissWrap(encodeAx25(f));
  out[1] = channel << 4;
  return out;
};

/** A fake TNC that writes `frames` once the client is connected and keeps what the client wrote. */
async function fakeTnc(frames: Uint8Array[] = []) {
  const written: number[] = [];
  const server = net.createServer((sock) => {
    sock.on("error", () => {});
    sock.on("data", (d: Buffer) => written.push(...d));
    setTimeout(() => {
      for (const f of frames) sock.write(Buffer.from(f));
    }, 50);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  cleanups.push(() => server.close());
  return { port: (server.address() as net.AddressInfo).port, written };
}

/** The KISS frames in a byte stream, as [type byte, ...body]. */
const kissFrames = (bytes: number[]) =>
  bytes
    .reduce<number[][]>(
      (acc, b) => {
        if (b === 0xc0) acc.push([]);
        else acc[acc.length - 1]!.push(b);
        return acc;
      },
      [[]],
    )
    .filter((f) => f.length);

const HEARD = { src: "OE8XYZ-7", dst: "APRS", path: ["WIDE1-1"], payload: ">on channel 2" };

describe("KISS channels", () => {
  it("reports a frame heard on channel 2 on port kiss-tnc-2 and digipeats it back on channel 2", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    cleanups.push(() => vi.restoreAllMocks());
    const tnc0 = await fakeTnc([onChannel(2, HEARD)]);
    const got: Packet[] = [];
    const tnc = new KissTnc(
      { host: "127.0.0.1", port: tnc0.port, channels: [0, 2], timing: null },
      {
        onPacket: (p) => got.push(p),
        onFrame: (f, ch) =>
          new Digipeater(tnc.channel(ch), { mycall: "OE8APR-10", aliases: new Set(["WIDE1"]) }).onFrame(f),
      },
    );
    tnc.start();
    cleanups.push(() => tnc["link"].stop());
    await until(() => tnc0.written.length > 0);
    expect(got.map((p) => p.port)).toEqual(["kiss-tnc-2"]);
    const sent = kissFrames(tnc0.written);
    expect(sent).toHaveLength(1);
    expect(sent[0]![0]).toBe(0x20); // a data frame on channel 2
  });

  it("reports a frame heard on channel 8 on port kiss-tnc-8: a type byte with bit 7 set and no SMACK CRC is data", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    cleanups.push(() => vi.restoreAllMocks());
    const tnc0 = await fakeTnc([onChannel(8, HEARD)]);
    const got: Packet[] = [];
    const tnc = new KissTnc(
      { host: "127.0.0.1", port: tnc0.port, channels: [0, 8], timing: null },
      { onPacket: (p) => got.push(p) },
    );
    tnc.start();
    cleanups.push(() => tnc["link"].stop());
    await until(() => got.length > 0);
    expect(got.map((p) => [p.port, p.payload])).toEqual([["kiss-tnc-8", ">on channel 2"]]);
  });

  it("ignores a frame on a channel the box does not list", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    cleanups.push(() => vi.restoreAllMocks());
    const tnc0 = await fakeTnc([
      onChannel(1, HEARD),
      onChannel(1, HEARD),
      onChannel(0, { ...HEARD, payload: ">zero" }),
    ]);
    const got: Packet[] = [];
    const tnc = new KissTnc({ host: "127.0.0.1", port: tnc0.port, timing: null }, { onPacket: (p) => got.push(p) });
    tnc.start();
    cleanups.push(() => tnc["link"].stop());
    await until(() => got.length > 0);
    await new Promise((r) => setTimeout(r, 100));
    expect(got.map((p) => [p.port, p.payload])).toEqual([["kiss-tnc", ">zero"]]);
    // the unlisted channel is logged once, not per frame
    expect(vi.mocked(console.log).mock.calls.filter((c) => String(c[0]).includes("ignored"))).toHaveLength(1);
    // nothing goes out on a channel the box does not list
    expect(tnc.send({ src: "OE8APR-10", dst: "APRS", payload: ">x" }, 1)).toBe(false);
  });

  it("sends the timing to every listed channel", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    cleanups.push(() => vi.restoreAllMocks());
    const tnc0 = await fakeTnc();
    const tnc = new KissTnc(
      { host: "127.0.0.1", port: tnc0.port, channels: [0, 2], timing: { txDelay: 30, persist: 63, slotTime: 10 } },
      { onPacket: () => {} },
    );
    tnc.start();
    cleanups.push(() => tnc["link"].stop());
    await until(() => tnc0.written.length >= 24);
    expect(kissFrames(tnc0.written)).toEqual([
      [0x01, 30],
      [0x02, 63],
      [0x03, 10],
      [0x21, 30],
      [0x22, 63],
      [0x23, 10],
    ]);
  });

  it("gates a channel-2 hearing to APRS-IS, and a message for that station back on channel 2", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    cleanups.push(() => vi.restoreAllMocks());
    const tnc0 = await fakeTnc([onChannel(2, HEARD)]);
    const isLines: string[] = [];
    const g = new Igate(
      { send: () => false },
      { host: "127.0.0.1", port: 1, call: "OE8APR-10", pass: "1", canTx: () => true },
    );
    g["ready"] = true;
    g["sock"] = { write: (l: string) => isLines.push(l) } as unknown as net.Socket;
    const heard: ParsedFrame[] = [];
    const tnc = new KissTnc(
      { host: "127.0.0.1", port: tnc0.port, channels: [0, 2], timing: null },
      {
        onPacket: () => {},
        onFrame: (f, ch) => {
          heard.push(f);
          g.onRf(f, tnc.channel(ch));
        },
      },
    );
    tnc.start();
    cleanups.push(() => tnc["link"].stop());
    await until(() => heard.length > 0);
    expect(isLines).toHaveLength(1);
    expect(isLines[0]).toContain("qAR,OE8APR-10:>on channel 2");
    g.onIsLine("OE5ABC>APRS,TCPIP*,qAC,T2AUSTRIA::OE8XYZ-7 :hello{1");
    await until(() => tnc0.written.length > 0);
    const sent = kissFrames(tnc0.written);
    expect(sent).toHaveLength(1);
    expect(sent[0]![0]).toBe(0x20);
  });
});

describe("kissChannelsFromEnv", () => {
  it("defaults to channel 0", () => {
    expect(kissChannelsFromEnv({})).toEqual({ channels: [0], tx: 0 });
  });

  it("reads the list and takes the first as the transmit channel", () => {
    expect(kissChannelsFromEnv({ KISS_TNC_CHANNELS: "2, 0,2" })).toEqual({ channels: [2, 0], tx: 2 });
    expect(kissChannelsFromEnv({ KISS_TNC_CHANNELS: "0,2", KISS_TNC_TX_CHANNEL: "2" })).toEqual({
      channels: [0, 2],
      tx: 2,
    });
  });

  it("refuses a value that is no channel, and a transmit channel the list leaves out", () => {
    expect(() => kissChannelsFromEnv({ KISS_TNC_CHANNELS: "0,16" })).toThrow(/0-15/);
    expect(() => kissChannelsFromEnv({ KISS_TNC_CHANNELS: "a" })).toThrow(/0-15/);
    expect(() => kissChannelsFromEnv({ KISS_TNC_CHANNELS: "0", KISS_TNC_TX_CHANNEL: "2" })).toThrow(/not in/);
  });
});
