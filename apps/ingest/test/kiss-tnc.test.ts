// SPDX-License-Identifier: AGPL-3.0-or-later
// KissTnc over a real TCP socket: a frame split across reads behind a whole frame keeps its boundary, and
// a KISS command frame is never taken for a heard frame.
import { describe, it, expect, afterEach, vi } from "vitest";
import net from "node:net";
import { encodeAx25, kissWrap } from "@aprscaching/aprs";
import type { Packet } from "@aprscaching/shared";
import { KissTnc } from "../src/kiss.js";

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
