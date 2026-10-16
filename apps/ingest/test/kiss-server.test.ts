// SPDX-License-Identifier: AGPL-3.0-or-later
// The KISS server over real TCP sockets: clients share a KISS TNC's two channels with the box. What the TNC hears
// reaches every client that sees the channel; a client's frame reaches the TNC on its channel only with transmit on,
// from a listed call, through the transmit gate; and a client's frame never becomes one of the box's hearings.
import { describe, it, expect, afterEach, vi } from "vitest";
import net from "node:net";
import { encodeAx25, kissCommand, kissDecode, kissWrap, type KissFrame } from "@aprscaching/aprs";
import { kissTncPort, type Packet } from "@aprscaching/shared";
import { KissTnc } from "../src/kiss.js";
import { SentFrames } from "../src/echo.js";
import { KissServer, kissServerSettings, type KissServerSettings } from "../src/hubserver.js";

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
  vi.restoreAllMocks();
});
const until = async (cond: () => boolean, ms = 3000) => {
  const t0 = Date.now();
  while (!cond() && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 20));
};
const settle = () => new Promise((r) => setTimeout(r, 150));

const RADIOS = [kissTncPort(0), kissTncPort(1)];
const ui = (src: string, payload: string) => encodeAx25({ src, dst: "APZACH", path: ["WIDE1-1"], payload });

/** A fake KISS TNC: keeps what the box writes, writes frames to the box, and with `echo` sends each one back. */
async function fakeTnc(echo = false) {
  const written: KissFrame[] = [];
  let sock: net.Socket | null = null;
  const server = net.createServer((s) => {
    sock = s;
    s.on("error", () => {});
    s.on("data", (d: Buffer) => {
      written.push(...kissDecode(d));
      if (echo) s.write(d);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  cleanups.push(() => server.close());
  return {
    port: (server.address() as net.AddressInfo).port,
    written,
    hear: (frame: Uint8Array, channel: number) => sock!.write(kissWrap(frame, channel)),
    connected: () => sock !== null,
  };
}

/** A KISS client of the server that keeps every frame it is sent. */
async function client(port: number) {
  const got: KissFrame[] = [];
  const s = net.connect(port, "127.0.0.1");
  s.on("error", () => {});
  s.on("data", (d: Buffer) => got.push(...kissDecode(d)));
  await new Promise<void>((r) => s.once("connect", () => r()));
  cleanups.push(() => s.destroy());
  return { got, send: (bytes: Uint8Array) => s.write(bytes) };
}

/** The box: a KISS TNC on channels 0 and 1, its batch, its call gate, and the KISS server sharing both channels. */
async function box(o: { tx: boolean; txCalls?: string[]; echo?: boolean; confirmed?: string[] }) {
  vi.spyOn(console, "log").mockImplementation(() => {});
  const tnc0 = await fakeTnc(o.echo);
  const batch: Packet[] = [];
  const gateAsked: string[] = [];
  const confirmed = new Set(o.confirmed ?? ["OE8APR"]);
  let server: KissServer | null = null;
  const tnc = new KissTnc(
    { host: "127.0.0.1", port: tnc0.port, channels: [0, 1], timing: null, sent: new SentFrames() },
    { onPacket: (p) => batch.push(p), onRaw: (b, ch) => server?.heard(kissTncPort(ch), b) },
  );
  tnc.start();
  cleanups.push(() => tnc["link"].stop());
  const settings: KissServerSettings = {
    host: "127.0.0.1",
    port: 0,
    listeners: [{ tcpPort: 0, kiss: 1 }],
    map: RADIOS.map((radio, kiss) => ({ kiss, radio })),
    maxClients: 4,
    tx: o.tx,
    txCalls: o.txCalls ?? ["OE8APR"],
    pacing: { burst: 10, refillSec: 6 },
  };
  const log: string[] = [];
  server = new KissServer(
    settings,
    RADIOS.map((name, ch) => ({
      name,
      sendRaw: (frame, call) => {
        gateAsked.push(call);
        return confirmed.has(call) && tnc.channel(ch).sendRaw(frame);
      },
    })),
    { log: (m) => log.push(m) },
  );
  await server.start();
  cleanups.push(() => server!.stop());
  await until(tnc0.connected);
  const [all, single] = server.ports();
  return { tnc0, batch, gateAsked, log, server, allPort: all!, singlePort: single! };
}

describe("KISS server", () => {
  it("sends what the TNC hears to every client that sees the channel, on the client's number", async () => {
    const b = await box({ tx: false });
    const a = await client(b.allPort);
    const a2 = await client(b.allPort);
    const one = await client(b.singlePort);
    await settle();
    const f0 = ui("OE8XYZ-7", ">heard on channel 0");
    const f1 = ui("OE8XYZ-9", ">heard on channel 1");
    b.tnc0.hear(f0, 0);
    b.tnc0.hear(f1, 1);
    await until(() => a.got.length === 2 && a2.got.length === 2 && one.got.length === 1);
    for (const c of [a, a2])
      expect(c.got).toEqual([
        { port: 0, command: 0, frame: f0 },
        { port: 1, command: 0, frame: f1 },
      ]);
    // the single-port listener carries channel 1 as port 0, and nothing of channel 0
    expect(one.got).toEqual([{ port: 0, command: 0, frame: f1 }]);
    // the box still hears both frames itself
    expect(b.batch.map((p) => p.port)).toEqual(["kiss-tnc", "kiss-tnc-1"]);
  });

  it("transmits nothing for a client with transmit off, the default", async () => {
    expect(kissServerSettings({ KISS_SERVER_PORT: "8101" }, RADIOS, ["OE8APR-10"])!.tx).toBe(false);
    const b = await box({ tx: false });
    const a = await client(b.allPort);
    a.send(kissWrap(ui("OE8APR-7", ">may I?"), 0));
    await settle();
    expect(b.tnc0.written).toEqual([]);
    expect(b.gateAsked).toEqual([]);
    expect(b.log.some((l) => /transmit through the server is off/.test(l))).toBe(true);
  });

  it("sends a listed call's frame to the TNC on the channel the client means, through the gate", async () => {
    const b = await box({ tx: true });
    const a = await client(b.allPort);
    const one = await client(b.singlePort);
    const f1 = ui("OE8APR-7", ">via port 1");
    const f0as1 = ui("OE8APR-8", ">via the single-port listener");
    a.send(kissWrap(f1, 1));
    one.send(kissWrap(f0as1, 0));
    await until(() => b.tnc0.written.length === 2);
    expect(b.tnc0.written).toEqual([
      { port: 1, command: 0, frame: f1 },
      { port: 1, command: 0, frame: f0as1 },
    ]);
    // the gate judges each frame by the base call it goes out under
    expect(b.gateAsked).toEqual(["OE8APR", "OE8APR"]);
  });

  it("drops a frame from a call the server does not list, and one the gate refuses", async () => {
    const b = await box({ tx: true, txCalls: ["OE8APR", "OE1XYZ"], confirmed: ["OE8APR"] });
    const a = await client(b.allPort);
    a.send(kissWrap(ui("OE9ABC-1", ">not listed"), 0));
    a.send(kissWrap(ui("OE1XYZ-1", ">listed, not confirmed"), 0));
    await settle();
    expect(b.tnc0.written).toEqual([]);
    expect(b.gateAsked).toEqual(["OE1XYZ"]);
    expect(b.log.some((l) => /not a call KISS_SERVER_TX_CALLS lists/.test(l))).toBe(true);
    expect(b.log.some((l) => /transmit gate refused/.test(l))).toBe(true);
  });

  it("never sends a client's KISS commands to the TNC", async () => {
    const b = await box({ tx: true });
    const a = await client(b.allPort);
    a.send(Uint8Array.from([...kissCommand(1, 5), ...kissCommand(3, 1, 1), 0xc0, 0xff, 0xc0]));
    await settle();
    expect(b.tnc0.written).toEqual([]);
  });

  it("never reports a client's frame as a hearing, even when the TNC sends it back", async () => {
    const b = await box({ tx: true, echo: true });
    const a = await client(b.allPort);
    const other = await client(b.allPort);
    a.send(kissWrap(ui("OE8APR-7", ">sent by a client"), 0));
    await until(() => b.tnc0.written.length === 1);
    await settle();
    expect(b.batch).toEqual([]);
    expect(other.got).toEqual([]);
    expect(a.got).toEqual([]);
  });
});

describe("kissServerSettings", () => {
  it("is off without KISS_SERVER_PORT", () => {
    expect(kissServerSettings({}, RADIOS, ["OE8APR-10"])).toBeNull();
  });

  it("listens on loopback, exposes every radio port and transmits as the box's base calls by default", () => {
    const s = kissServerSettings({ KISS_SERVER_PORT: "8101" }, RADIOS, ["OE8APR-10", "OE8APR-11", "OE8ABC"])!;
    expect(s).toMatchObject({
      host: "127.0.0.1",
      port: 8101,
      listeners: [],
      map: [
        { kiss: 0, radio: "kiss-tnc" },
        { kiss: 1, radio: "kiss-tnc-1" },
      ],
      maxClients: 8,
      tx: false,
      txCalls: ["OE8APR", "OE8ABC"],
    });
  });

  it("reads the listed ports, listeners and calls", () => {
    const s = kissServerSettings(
      {
        KISS_SERVER_PORT: "8101",
        KISS_SERVER_HOST: "192.168.1.10",
        KISS_SERVER_PORTS: "kiss-tnc-1",
        KISS_SERVER_PORT_LISTENERS: "8102=0",
        KISS_SERVER_TX: "1",
        KISS_SERVER_TX_CALLS: "oe8apr-7, OE8XYZ",
        KISS_SERVER_MAX_CLIENTS: "2",
      },
      RADIOS,
      [],
    )!;
    expect(s).toMatchObject({
      host: "192.168.1.10",
      map: [{ kiss: 0, radio: "kiss-tnc-1" }],
      listeners: [{ tcpPort: 8102, kiss: 0 }],
      tx: true,
      txCalls: ["OE8APR", "OE8XYZ"],
      maxClients: 2,
    });
  });

  it("refuses a box with no radio port, an unknown radio port and a listener on the server's own port", () => {
    expect(() => kissServerSettings({ KISS_SERVER_PORT: "8101" }, [], [])).toThrow(/no radio port/);
    expect(() => kissServerSettings({ KISS_SERVER_PORT: "8101", KISS_SERVER_PORTS: "lora-aprs" }, RADIOS, [])).toThrow(
      /KISS_SERVER_PORTS: "lora-aprs" is not a radio port/,
    );
    expect(() =>
      kissServerSettings({ KISS_SERVER_PORT: "8101", KISS_SERVER_PORT_LISTENERS: "8101=0" }, RADIOS, []),
    ).toThrow(/KISS_SERVER_PORT already/);
  });
});
