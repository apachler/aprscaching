// SPDX-License-Identifier: AGPL-3.0-or-later
// Text the box originates goes out on the air as UTF-8 bytes; a frame it relays keeps the bytes it heard.
import { describe, it, expect, afterEach } from "vitest";
import net from "node:net";
import { decodeAx25, encodeAx25, kissDecode } from "@aprscaching/aprs";
import { KissTnc } from "../src/kiss.js";
import { BoxPoller } from "../src/boxpoll.js";
import { Digipeater } from "../src/digipeater.js";
import { AprsUplink } from "../src/uplink.js";

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((c) => c()));
const until = async (cond: () => boolean, ms = 3000) => {
  const t0 = Date.now();
  while (!cond() && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 20));
};

/** A fake TCP peer that records every byte written to it; `greet` is written once a client connects. */
async function recorder(greet?: string): Promise<{ port: number; bytes: () => Buffer }> {
  const got: Buffer[] = [];
  const server = net.createServer((sock) => {
    sock.on("error", () => {});
    sock.on("data", (d) => got.push(d));
    if (greet) sock.write(greet);
    cleanups.push(() => sock.destroy());
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  cleanups.push(() => server.close());
  return { port: (server.address() as net.AddressInfo).port, bytes: () => Buffer.concat(got) };
}

/** A KISS TNC over TCP, once its link is up. */
async function tnc(port: number): Promise<KissTnc> {
  const t = new KissTnc({ host: "127.0.0.1", port }, { onPacket: () => {} });
  t.start();
  cleanups.push(() => t["link"].tcp.stop());
  await until(() => t["connected"] === true);
  return t;
}

/** The info field of each AX.25 frame in a KISS byte stream. */
const infos = (stream: Buffer): Buffer[] =>
  kissDecode(Uint8Array.from(stream)).map((k) => {
    const i = k.frame.indexOf(0xf0, k.frame.indexOf(0x03));
    return Buffer.from(k.frame.subarray(i + 1));
  });

describe("text sent on RF", () => {
  it("sends a gateway-queued message as UTF-8 bytes over KISS", async () => {
    const peer = await recorder();
    const kiss = await tnc(peer.port);
    const poller = new BoxPoller({
      base: "http://gw",
      secret: "s",
      boxId: "pi-home",
      boxCall: "OE8APR-10",
      remoteTx: true,
      radio: kiss,
      state: { tx: true, digi: false, igate: false },
      log: () => {},
    });
    const r = await poller.execute({
      id: 1,
      kind: "message",
      callsign: "OE8APR-10",
      createdAt: Math.floor(Date.now() / 1000),
      payload: { to: "OE5XYZ", text: "Grüße aus Graz" },
    });
    expect(r.status).toBe("done");
    await until(() => infos(peer.bytes()).length > 0);
    const [info] = infos(peer.bytes());
    expect(info!.toString("latin1")).toMatch(/^:OE5XYZ {3}:/);
    expect(info!.includes(Buffer.from("Grüße aus Graz", "utf8"))).toBe(true);
    expect(info!.toString("utf8")).toMatch(/^:OE5XYZ {3}:Grüße aus Graz\{\d+$/);
  });

  it("sends an answer to a radio command as UTF-8 bytes, inside the third-party header", async () => {
    const peer = await recorder();
    const kiss = await tnc(peer.port);
    const poller = new BoxPoller({
      base: "http://gw",
      secret: "s",
      boxId: "pi-home",
      boxCall: "OE8APR-10",
      serviceCall: "APRSCG",
      remoteTx: true,
      radio: kiss,
      state: { tx: true, digi: false, igate: false },
      log: () => {},
    });
    const r = await poller.execute({
      id: 2,
      kind: "aprs_msg",
      callsign: "OE8APR-10",
      createdAt: Math.floor(Date.now() / 1000),
      payload: { from: "APRSCG", to: "OE5XYZ", text: "Schöne Grüße", msgNo: "A1" },
    });
    expect(r.status).toBe("done");
    await until(() => infos(peer.bytes()).length > 0);
    expect(infos(peer.bytes())[0]!.toString("utf8")).toBe("}APRSCG>APZACG,TCPIP,OE8APR-10*::OE5XYZ   :Schöne Grüße{A1");
  });

  it("digipeats a Latin-1 frame with its bytes unchanged", async () => {
    const peer = await recorder();
    const kiss = await tnc(peer.port);
    const digi = new Digipeater(kiss, { mycall: "OE8APR-10", aliases: new Set(["WIDE1"]) });
    // "Grüße" in Latin-1: 0xfc and 0xdf are not valid UTF-8 here
    const heardInfo = Buffer.from(":OE5XYZ   :Gr\xfc\xdfe{3", "latin1");
    const heard = decodeAx25(
      encodeAx25({ src: "OE3PLY-7", dst: "APRS", path: ["WIDE1-1"], payload: heardInfo.toString("latin1") }),
    )!;
    digi.onFrame(heard);
    await until(() => infos(peer.bytes()).length > 0);
    expect(infos(peer.bytes())[0]!.equals(heardInfo)).toBe(true);
  });
});

describe("text sent on APRS-IS", () => {
  it("writes an outbox line with non-ASCII text as UTF-8 bytes", async () => {
    const peer = await recorder("# logresp OE8APR-1 verified, server T2TEST\r\n");
    const up = new AprsUplink({ host: "127.0.0.1", port: peer.port, serviceCall: "OE8APR-1", servicePass: "1" });
    up.start();
    cleanups.push(() => up["sock"]?.destroy());
    await until(() => up.verified);
    expect(up.publish({ src_call: "OE8APR-1", tocall: "APZACG", payload: ":OE5XYZ   :Grüße{7" })).toBe(true);
    const line = Buffer.from("OE8APR-1>APZACG,TCPIP*::OE5XYZ   :Grüße{7\r\n", "utf8");
    await until(() => peer.bytes().includes(line));
    expect(peer.bytes().includes(line)).toBe(true);
  });
});
