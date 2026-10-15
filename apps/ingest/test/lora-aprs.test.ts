// SPDX-License-Identifier: AGPL-3.0-or-later
// The LoRa APRS port: it reads the prefixed TNC2 line, an iGate's AX.25 rendering and a bare line; it stamps the
// receiving site only on a direct hearing, like a TNC port; it drops lines that came from APRS-IS and a MeshCom
// node's frames; and it reads an iGate's TNC server over a real socket in both of its forms.
import { describe, it, expect, afterEach, vi } from "vitest";
import net from "node:net";
import { encodeAx25, kissWrap, rfText } from "@aprscaching/aprs";
import type { Packet } from "@aprscaching/shared";
import {
  decodeLoraPacket,
  fromAprsIs,
  loraPacket,
  loraSettings,
  loraStatus,
  LoraAprsPort,
  LORA_APRS_PREFIX,
  sanitizeLoraMeta,
  type LoraSettings,
} from "../src/lora-aprs.js";

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((c) => c()));
const until = async (cond: () => boolean, ms = 3000) => {
  const t0 = Date.now();
  while (!cond() && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 20));
};

const lora = (line: string) => Uint8Array.from([...LORA_APRS_PREFIX, ...new TextEncoder().encode(line)]);
const POS = "OE8APR-7>APLRT1,WIDE1-1:!4703.33N/01525.56E>LoRa";
const quiet = { log: () => {}, error: () => {} };
const settings = (o: Partial<LoraSettings> = {}): LoraSettings => ({ ...loraSettings({}), ...o });

describe("decodeLoraPacket", () => {
  it("strips the prefix and parses the TNC2 line", () => {
    const d = decodeLoraPacket(lora(POS))!;
    expect(d.form).toBe("lora");
    expect(d.frame).toMatchObject({
      src: "OE8APR-7",
      dst: "APLRT1",
      path: ["WIDE1-1"],
      payload: "!4703.33N/01525.56E>LoRa",
    });
    expect(d.airBytes).toBe(3 + POS.length);
  });

  it("keeps the bytes one character per byte, for the gateway to read as UTF-8 where they are", () => {
    expect(rfText(decodeLoraPacket(lora("OE8APR-7>APLRT1:>Grüße"))!.frame.payload)).toBe(">Grüße");
    const b = Uint8Array.from([...lora("OE8APR-7>APLRT1:>x"), 0xe9, 0x96]);
    expect(decodeLoraPacket(b)!.frame.payload).toBe(">xé\u0096");
  });

  it("drops a trailing line break the firmware adds", () => {
    expect(decodeLoraPacket(lora(`${POS}\r\n`))!.frame.payload).toBe("!4703.33N/01525.56E>LoRa");
  });

  it("reads an iGate's AX.25 rendering, its UTF-8 info field included", () => {
    const info = new TextEncoder().encode(">Grüße");
    const ax = encodeAx25({
      src: "OE8APR-7",
      dst: "APLRT1",
      path: ["OE8XYZ-10*"],
      payload: Buffer.from(info).toString("latin1"),
    });
    const d = decodeLoraPacket(ax)!;
    expect(d.form).toBe("ax25");
    expect(d.frame).toMatchObject({ src: "OE8APR-7", path: ["OE8XYZ-10*"] });
    expect(rfText(d.frame.payload)).toBe(">Grüße");
    expect(rfText(d.frame.raw!)).toBe("OE8APR-7>APLRT1,OE8XYZ-10*:>Grüße");
    expect(d.airBytes).toBe(3 + new TextEncoder().encode(rfText(d.frame.raw!)).length);
  });

  it("reads a bare TNC2 line", () => {
    const d = decodeLoraPacket(new TextEncoder().encode(POS))!;
    expect(d.form).toBe("text");
    expect(d.frame.src).toBe("OE8APR-7");
  });

  it("refuses what is not a packet", () => {
    expect(decodeLoraPacket(LORA_APRS_PREFIX)).toBeNull();
    expect(decodeLoraPacket(lora("no header here"))).toBeNull();
    expect(decodeLoraPacket(lora("OE8APR-7>APLRT1:"))).toBeNull(); // no info field
    expect(decodeLoraPacket(lora("OE8 APR>APLRT1:>x"))).toBeNull(); // an address with a space
    expect(decodeLoraPacket(lora("OE8APR>APLRT1:>a\nOE8APR>APLRT1:>b"))).toBeNull(); // two lines
    expect(decodeLoraPacket(Uint8Array.of(1, 2, 3, 4, 5))).toBeNull();
  });
});

describe("fromAprsIs", () => {
  it("knows a line from APRS-IS by its q-construct or TCPIP hop", () => {
    expect(fromAprsIs({ path: ["WIDE1-1", "qAR", "OE8XYZ-10"] })).toBe(true);
    expect(fromAprsIs({ path: ["TCPIP*", "qAC", "T2TEST"] })).toBe(true);
    expect(fromAprsIs({ path: ["QAO", "OE8XYZ"] })).toBe(true); // the AX.25 rendering upper-cases it
    expect(fromAprsIs({ path: ["WIDE1-1"] })).toBe(false);
    expect(fromAprsIs({ path: [] })).toBe(false);
  });
});

describe("loraPacket", () => {
  it("is a TNC port's packet on lora-aprs, naming the site only for a direct hearing", () => {
    const direct = decodeLoraPacket(lora(POS))!.frame;
    expect(loraPacket(direct, "oe8apr-10", 100)).toMatchObject({
      port: "lora-aprs",
      heardVia: "rf",
      igateCall: "OE8APR-10",
      ts: 100,
      raw: POS,
    });
    const digi = decodeLoraPacket(lora("OE8APR-7>APLRT1,OE8XYZ-10*:>hi"))!.frame;
    expect(loraPacket(digi, "OE8APR-10", 100).igateCall).toBeUndefined();
    expect(loraPacket(direct, undefined, 100).igateCall).toBeUndefined();
  });

  it("carries a receiver's report as metadata, sane values only", () => {
    const f = decodeLoraPacket(lora(POS))!.frame;
    expect(loraPacket(f, undefined, 1).parsed).toBeUndefined();
    expect(loraPacket(f, undefined, 1, { rssi: -112, snr: -7.5, freqOffsetHz: 1450 }).parsed).toEqual({
      lora: { rssi: -112, snr: -7.5, freqOffsetHz: 1450 },
    });
    expect(sanitizeLoraMeta({ rssi: 400, snr: Number.NaN, freqOffsetHz: -300 })).toEqual({ freqOffsetHz: -300 });
    expect(sanitizeLoraMeta({ rssi: 99 })).toBeUndefined();
  });
});

describe("loraSettings", () => {
  it("defaults to Standard on 433.775 MHz over KISS", () => {
    expect(loraSettings({})).toEqual({
      preset: "standard",
      protocol: "kiss",
      freqMhz: 433.775,
      sf: 9,
      bwKhz: 125,
      cr: 7,
    });
  });

  it("takes Fast, the UK frequency and the text form", () => {
    expect(
      loraSettings({ LORA_APRS_PRESET: "fast", LORA_APRS_FREQ_MHZ: "439.9125", LORA_APRS_PROTOCOL: "text" }),
    ).toEqual({ preset: "fast", protocol: "text", freqMhz: 439.9125, sf: 8, bwKhz: 125, cr: 6 });
  });

  it("reads the custom values only with the custom preset", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    cleanups.push(() => warn.mockRestore());
    expect(loraSettings({ LORA_APRS_SF: "12" }).sf).toBe(9);
    expect(warn).toHaveBeenCalled();
    expect(
      loraSettings({ LORA_APRS_PRESET: "custom", LORA_APRS_SF: "12", LORA_APRS_BW_KHZ: "62.5", LORA_APRS_CR: "5" }),
    ).toMatchObject({ preset: "custom", sf: 12, bwKhz: 62.5, cr: 5 });
  });

  it("refuses values a LoRa radio does not offer", () => {
    expect(() => loraSettings({ LORA_APRS_PRESET: "custom", LORA_APRS_BW_KHZ: "100" })).toThrow(/bandwidth/);
    expect(() => loraSettings({ LORA_APRS_PRESET: "custom", LORA_APRS_SF: "9.5" })).toThrow(/LORA_APRS_SF/);
    expect(() => loraSettings({ LORA_APRS_PRESET: "turbo" })).toThrow(/LORA_APRS_PRESET/);
    expect(() => loraSettings({ LORA_APRS_PROTOCOL: "ax25" })).toThrow(/LORA_APRS_PROTOCOL/);
  });
});

describe("loraStatus", () => {
  it("names the frequency, the preset, its settings and a typical packet's airtime", () => {
    expect(loraStatus(loraSettings({}))).toBe(
      "433.775 MHz · Standard (BW 125 kHz, SF9, CR 4:7, 1256 bit/s) · a 60-byte packet is 484 ms on air",
    );
    expect(loraStatus(loraSettings({ LORA_APRS_PRESET: "fast" }))).toContain(
      "Fast (BW 125 kHz, SF8, CR 4:6, 2604 bit/s)",
    );
  });
});

describe("LoraAprsPort", () => {
  const port = (s = settings()) => {
    const got: Packet[] = [];
    const p = new LoraAprsPort({ host: "127.0.0.1", port: 1, settings: s, siteCall: "OE8APR-10", log: quiet }, (x) =>
      got.push(x),
    );
    return { p, got };
  };

  it("forwards heard packets, counts what it drops, and sums their airtime", () => {
    const { p, got } = port();
    p.onBytes(lora(POS));
    p.onBytes(lora("OE8APR-7>APLRT1,TCPIP*,qAC,T2TEST:>from the internet"));
    p.onBytes(lora("rubbish"));
    expect(got.map((x) => x.src)).toEqual(["OE8APR-7"]);
    expect(p.stats).toMatchObject({ received: 3, decoded: 1, fromAprsIs: 1, rejected: 1, forms: { lora: 1 } });
    expect(p.stats.airtimeMs).toBeGreaterThan(400);
    expect(p.counters(Date.now() + 60_000).channelPct).toBeGreaterThan(0);
  });

  it("reports each packet it rejects for the port's health", () => {
    let invalid = 0;
    const p = new LoraAprsPort(
      { host: "127.0.0.1", port: 1, settings: settings(), log: quiet, onInvalid: () => invalid++ },
      () => {},
    );
    p.onBytes(lora("rubbish"));
    p.onBytes(lora(POS));
    expect(invalid).toBe(1);
  });

  it("never takes a MeshCom node's frames for its own hearings", () => {
    const { p, got } = port();
    const mc = encodeAx25({ src: "OE8APR-12", dst: "APRSMC", payload: ">relayed" });
    p.onKiss({ port: 0, command: 0, frame: mc });
    p.onKiss({ port: 0, command: 0, frame: lora(POS) });
    expect(got).toHaveLength(0);
  });

  async function serve(chunks: Uint8Array[]): Promise<number> {
    const server = net.createServer((sock) => {
      sock.on("error", () => {});
      sock.setNoDelay(true);
      void (async () => {
        for (const c of chunks) {
          sock.write(Buffer.from(c));
          await new Promise((r) => setTimeout(r, 40));
        }
      })();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    cleanups.push(() => server.close());
    return (server.address() as net.AddressInfo).port;
  }

  const connect = (portNo: number, s: LoraSettings) => {
    const got: Packet[] = [];
    const p = new LoraAprsPort({ host: "127.0.0.1", port: portNo, settings: s, statsMs: 0, log: quiet }, (x) =>
      got.push(x),
    );
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    cleanups.push(() => {
      p.stop();
      log.mockRestore();
    });
    p.start();
    return got;
  };

  it("reads KISS frames from the iGate: the AX.25 rendering and the prefixed line", async () => {
    const ax = kissWrap(encodeAx25({ src: "OE8APR-9", dst: "APLRG1", path: ["WIDE1-1"], payload: ">ax" }));
    const raw = kissWrap(lora(POS));
    const both = Uint8Array.from([...ax, ...raw]);
    const portNo = await serve([both.slice(0, 7), both.slice(7)]);
    const got = connect(portNo, settings());
    await until(() => got.length >= 2);
    expect(got.map((x) => x.src)).toEqual(["OE8APR-9", "OE8APR-7"]);
    expect(got.every((x) => x.port === "lora-aprs" && x.heardVia === "rf")).toBe(true);
  });

  it("reads the iGate's text lines, one packet per line, split across reads", async () => {
    const text = new TextEncoder().encode(`${POS}\r\nOE8APR-9>APLRG1:>zwei Grüße\r\n`);
    const portNo = await serve([text.slice(0, 20), text.slice(20, 61), text.slice(61)]);
    const got = connect(portNo, settings({ protocol: "text" }));
    await until(() => got.length >= 2);
    expect(got.map((x) => rfText(x.payload))).toEqual(["!4703.33N/01525.56E>LoRa", ">zwei Grüße"]);
  });
});
