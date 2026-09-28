// SPDX-License-Identifier: AGPL-3.0-or-later
// The AGWPE and WA8DED host-mode receive paths: a bounded buffer, a fresh one on every connection, and
// monitor headers paired only with the info block that immediately follows them.
import { describe, it, expect, afterEach } from "vitest";
import net from "node:net";
import { encodeAx25 } from "@aprscaching/aprs";
import { encodeAgwpe } from "@aprscaching/packet";
import type { Packet } from "@aprscaching/shared";
import { AgwpeRx, AgwpeTnc, AGWPE_MAX_DATA } from "../src/agwpe.js";
import { HostmodeRx, HostmodeTnc, HOSTMODE_RX_MAX_BYTES } from "../src/hostmode.js";

const str = (s: string) => Array.from(s, (c) => c.charCodeAt(0));
const header = (code: 4 | 5, text: string) => [0, code, ...str(text), 0];
const info = (text: string) => [0, 6, text.length - 1, ...str(text)];
const POS = "!4704.41N/01526.27E>hi";

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((c) => c()));
const until = async (cond: () => boolean, ms = 3000) => {
  const t0 = Date.now();
  while (!cond() && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 20));
};

/** A fake TNC that answers each successive connection with the next entry of `script`, then closes it. */
async function scriptedTnc(script: Uint8Array[]): Promise<{ port: number; connections: () => number }> {
  let n = 0;
  const server = net.createServer((sock) => {
    const bytes = script[n++];
    if (bytes) sock.end(Buffer.from(bytes));
    else sock.on("error", () => {});
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  cleanups.push(() => server.close());
  return { port: (server.address() as net.AddressInfo).port, connections: () => n };
}

describe("HostmodeRx pairs monitor headers with their info", () => {
  it("pairs a type-6 info block with the type-5 header just before it", () => {
    const rx = new HostmodeRx();
    const got = rx.push(
      Uint8Array.from([...header(5, "fm OE3PLY-7 to APRS via WIDE1-1 ctl UI^ pid F0"), ...info(POS)]),
    )!;
    expect(got).toHaveLength(1);
    expect(got[0]!.header).toBe("fm OE3PLY-7 to APRS via WIDE1-1 ctl UI^ pid F0");
    expect(String.fromCharCode(...got[0]!.info)).toBe(POS);
  });

  it("never pairs an info-less type-4 header with a later station's info", () => {
    const rx = new HostmodeRx();
    const got = rx.push(
      Uint8Array.from([
        ...header(4, "fm OE8APR to OE8XBM ctl SABM+"),
        ...header(5, "fm OE3PLY-7 to APRS ctl UI^ pid F0"),
        ...info(POS),
      ]),
    )!;
    expect(got.map((m) => m.header)).toEqual(["fm OE3PLY-7 to APRS ctl UI^ pid F0"]);
  });

  it("drops an info block with no header immediately before it", () => {
    const rx = new HostmodeRx();
    expect(rx.push(Uint8Array.from(info(POS)))).toEqual([]);
    const got = rx.push(
      Uint8Array.from([...header(5, "fm OE3PLY-7 to APRS ctl UI^ pid F0"), 0, 0, ...info(POS)]), // a success in between
    )!;
    expect(got).toEqual([]);
  });

  it("forgets a pending header on reset", () => {
    const rx = new HostmodeRx();
    expect(rx.push(Uint8Array.from(header(5, "fm OE3PLY-7 to APRS ctl UI^ pid F0")))).toEqual([]);
    rx.reset();
    expect(rx.push(Uint8Array.from(info(POS)))).toEqual([]);
  });

  it("gives up on a stream that never completes a frame within the cap", () => {
    const rx = new HostmodeRx();
    expect(rx.push(Uint8Array.from([0, 1, ...new Array(HOSTMODE_RX_MAX_BYTES).fill(0x41)]))).toBeNull();
    expect(rx.buffered).toBe(0);
  });
});

describe("AgwpeRx", () => {
  it("rejects a frame header declaring more data than the cap", () => {
    const rx = new AgwpeRx();
    const hdr = encodeAgwpe({ port: 0, kind: "K" });
    new DataView(hdr.buffer).setUint32(28, AGWPE_MAX_DATA + 1, true);
    expect(rx.push(hdr)).toBeNull();
    expect(rx.buffered).toBe(0);
  });

  it("holds a partial frame and completes it with the next chunk", () => {
    const rx = new AgwpeRx();
    const f = encodeAgwpe({ port: 0, kind: "K", data: Uint8Array.from([0, 1, 2]) });
    expect(rx.push(f.slice(0, 20))).toEqual([]);
    expect(rx.push(f.slice(20))!.map((x) => x.kind)).toEqual(["K"]);
    expect(rx.buffered).toBe(0);
  });
});

describe("a reconnect starts from an empty receive buffer", () => {
  const frame = { src: "OE3PLY-7", dst: "APRS", path: ["WIDE1-1"], payload: POS };

  it("AGWPE", async () => {
    const full = encodeAgwpe({ port: 0, kind: "K", data: Uint8Array.from([0, ...encodeAx25(frame)]) });
    const { port } = await scriptedTnc([full.slice(0, 20), full]);
    const got: Packet[] = [];
    const a = new AgwpeTnc({ host: "127.0.0.1", port, retryMs: 20 }, { onPacket: (p) => got.push(p) });
    cleanups.push(() => a.stop());
    a.start();
    await until(() => got.length > 0);
    expect(got.map((p) => p.payload)).toEqual([POS]);
  });

  it("WA8DED host mode", async () => {
    const { port } = await scriptedTnc([
      Uint8Array.from([...header(5, "fm OE8APR to APRS ctl UI^ pid F0"), 0, 6, POS.length - 1, ...str("!470")]),
      Uint8Array.from([...header(5, "fm OE3PLY-7 to APRS ctl UI^ pid F0"), ...info(POS)]),
    ]);
    const got: Packet[] = [];
    const h = new HostmodeTnc({ host: "127.0.0.1", port, retryMs: 20 }, { onPacket: (p) => got.push(p) });
    cleanups.push(() => h.stop());
    h.start();
    await until(() => got.length > 0);
    expect(got.map((p) => p.src)).toEqual(["OE3PLY-7"]);
  });
});
