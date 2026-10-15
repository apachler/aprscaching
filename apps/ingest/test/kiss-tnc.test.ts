// SPDX-License-Identifier: AGPL-3.0-or-later
// KissTnc over a real TCP socket: a frame split across reads behind a whole frame keeps its boundary, and
// a KISS command frame is never taken for a heard frame; the TNC is sent its timing after each connect.
import { describe, it, expect, afterEach, vi } from "vitest";
import net from "node:net";
import { encodeAx25, kissWrap } from "@aprscaching/aprs";
import type { Packet } from "@aprscaching/shared";
import { KissTnc, kissTimingFromEnv } from "../src/kiss.js";

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((c) => c()));
const until = async (cond: () => boolean, ms = 3000) => {
  const t0 = Date.now();
  while (!cond() && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 20));
};

/** A fake TNC writing each chunk as its own TCP read, with a pause between them. */
async function chunkedTnc(chunks: Uint8Array[]): Promise<number> {
  const server = net.createServer((sock) => {
    sock.on("error", () => {});
    sock.setNoDelay(true);
    void (async () => {
      for (const c of chunks) {
        sock.write(Buffer.from(c));
        await new Promise((r) => setTimeout(r, 60));
      }
    })();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  cleanups.push(() => server.close());
  return (server.address() as net.AddressInfo).port;
}

const ui = (payload: string) => kissWrap(encodeAx25({ src: "OE3PLY-7", dst: "APRS", payload }));

describe("KissTnc receive framing", () => {
  it("delivers a frame whose read began behind a complete frame", async () => {
    const a = ui(">first");
    const b = ui(`>second ÀÛ`); // FEND/FESC in the payload: escaped on the wire
    const split = 9;
    const port = await chunkedTnc([
      Uint8Array.from([...a, ...b.slice(0, split)]),
      b.slice(split),
      Uint8Array.from([0xc0, 0x01, 0x1e, 0xc0]), // TXDELAY: a KISS command, not a frame
    ]);
    const got: Packet[] = [];
    const raw: Uint8Array[] = [];
    const tnc = new KissTnc({ host: "127.0.0.1", port }, { onPacket: (p) => got.push(p), onRaw: (r) => raw.push(r) });
    tnc.start();
    cleanups.push(() => tnc["sock"]?.destroy());
    await until(() => got.length >= 2);
    await new Promise((r) => setTimeout(r, 200));
    expect(got.map((p) => p.payload)).toEqual([">first", `>second ÀÛ`]);
    expect(raw).toHaveLength(2);
  });
});

describe("KissTnc invalid frames", () => {
  it("counts a data frame no AX.25 decoder reads as invalid, and nothing else", async () => {
    const port = await chunkedTnc([ui(">ok"), kissWrap(Uint8Array.from([1, 2, 3, 4, 5]))]);
    const got: Packet[] = [];
    let invalid = 0;
    const tnc = new KissTnc({ host: "127.0.0.1", port }, { onPacket: (p) => got.push(p), onInvalid: () => invalid++ });
    tnc.start();
    cleanups.push(() => tnc["sock"]?.destroy());
    await until(() => invalid >= 1);
    expect(got.map((p) => p.payload)).toEqual([">ok"]);
    expect(invalid).toBe(1);
  });
});

describe("KissTnc connection", () => {
  it("turns on TCP keepalive, so a TNC host that vanished is noticed on a quiet channel", async () => {
    const port = await chunkedTnc([]);
    const spy = vi.spyOn(net.Socket.prototype, "setKeepAlive");
    cleanups.push(() => spy.mockRestore());
    const tnc = new KissTnc({ host: "127.0.0.1", port }, { onPacket: () => {} });
    tnc.start();
    cleanups.push(() => tnc["sock"]?.destroy());
    expect(spy).toHaveBeenCalledWith(true, 30_000);
  });
});

/** A fake TNC that keeps what each connection wrote to it; `dropFirst` closes the first connection soon after. */
async function recordingTnc(opts: { dropFirst?: boolean } = {}) {
  const conns: number[][] = [];
  const server = net.createServer((sock) => {
    sock.on("error", () => {});
    const got: number[] = [];
    conns.push(got);
    sock.on("data", (d: Buffer) => got.push(...d));
    if (opts.dropFirst && conns.length === 1) setTimeout(() => sock.destroy(), 50);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  cleanups.push(() => server.close());
  return { port: (server.address() as net.AddressInfo).port, conns };
}

const TIMING_BYTES = [0xc0, 0x01, 30, 0xc0, 0xc0, 0x02, 63, 0xc0, 0xc0, 0x03, 10, 0xc0];

describe("KissTnc timing", () => {
  it("sends TXDELAY, PERSIST and SLOTTIME after each connect, ahead of any frame", async () => {
    const tnc0 = await recordingTnc({ dropFirst: true });
    vi.spyOn(console, "log").mockImplementation(() => {});
    cleanups.push(() => vi.restoreAllMocks());
    const tnc = new KissTnc(
      { host: "127.0.0.1", port: tnc0.port, retryMs: 50, timing: { txDelay: 30, persist: 63, slotTime: 10 } },
      { onPacket: () => {} },
    );
    tnc.start();
    cleanups.push(() => tnc["link"].stop());
    await until(() => tnc0.conns.length >= 2 && tnc0.conns[1]!.length >= TIMING_BYTES.length);
    expect(tnc0.conns[0]).toEqual(TIMING_BYTES);
    expect(tnc0.conns[1]).toEqual(TIMING_BYTES);
    expect(tnc.send({ src: "OE8APR-10", dst: "APRS", payload: ">hi" })).toBe(true);
    await until(() => tnc0.conns[1]!.length > TIMING_BYTES.length);
    expect(tnc0.conns[1]!.slice(TIMING_BYTES.length, TIMING_BYTES.length + 2)).toEqual([0xc0, 0x00]);
  });

  it("sends nothing when the TNC keeps its own timing", async () => {
    const tnc0 = await recordingTnc();
    vi.spyOn(console, "log").mockImplementation(() => {});
    cleanups.push(() => vi.restoreAllMocks());
    const tnc = new KissTnc({ host: "127.0.0.1", port: tnc0.port, timing: null }, { onPacket: () => {} });
    tnc.start();
    cleanups.push(() => tnc["link"].stop());
    await until(() => tnc["connected"]);
    await new Promise((r) => setTimeout(r, 100));
    expect(tnc0.conns).toEqual([[]]);
  });
});

describe("kissTimingFromEnv", () => {
  it("takes the APRS defaults when nothing is set", () => {
    expect(kissTimingFromEnv({})).toEqual({ txDelay: 30, persist: 63, slotTime: 10 });
  });

  it("reads the three values, clamped to a byte", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    cleanups.push(() => vi.restoreAllMocks());
    expect(
      kissTimingFromEnv({ KISS_TIMING: "on", KISS_TXDELAY: "40", KISS_PERSIST: "300", KISS_SLOTTIME: "-1" }),
    ).toEqual({ txDelay: 40, persist: 255, slotTime: 0 });
  });

  it("sends none with KISS_TIMING=off", () => {
    expect(kissTimingFromEnv({ KISS_TIMING: "off", KISS_TXDELAY: "40" })).toBeNull();
    expect(kissTimingFromEnv({ KISS_TIMING: " OFF " })).toBeNull();
  });
});
