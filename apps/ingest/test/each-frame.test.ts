// SPDX-License-Identifier: AGPL-3.0-or-later
// One read can carry many frames. Every socket data handler hands them on one at a time, and a consumer that
// throws on one frame loses that frame only: the frames after it in the same read are still delivered, and the
// error goes to the port's own log rather than unwinding the handler.
import { describe, it, expect, afterEach, vi } from "vitest";
import dgram from "node:dgram";
import { encodeAx25, kissWrap } from "@aprscaching/aprs";
import { KissLink } from "../src/kiss.js";
import { LoraAprsPort, loraSettings } from "../src/lora-aprs.js";
import { MeshtasticTcp, type MeshtasticIngest } from "../src/meshtastic.js";
import { SoundcardPort } from "../src/soundcard.js";
import { MqttSubscriber, encodeRemainingLength } from "../src/mqtt.js";
import { MeshcomListener } from "../src/meshcom.js";

const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).forEach((c) => c()));

/** A consumer that throws on its first frame and records the rest. */
function firstThrows<T>() {
  const got: T[] = [];
  let n = 0;
  const take = (f: T) => {
    if (n++ === 0) throw new RangeError("first frame");
    got.push(f);
  };
  return { got, take };
}

const ui = (payload: string) => encodeAx25({ src: "OE8APR-9", dst: "APRS", path: [], payload });

describe("socket handlers dispatch each frame on its own", () => {
  it("KISS link (KISS TNC and LoRa KISS): the frames after a throwing one are delivered", () => {
    const { got, take } = firstThrows<{ frame: Uint8Array }>();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    cleanups.push(() => errors.mockRestore());
    const link = new KissLink({ host: "127.0.0.1", port: 1, tag: "test-kiss" }, take);
    const chunk = Buffer.from([...kissWrap(ui(">a")), ...kissWrap(ui(">b")), ...kissWrap(ui(">c"))]);
    (link as unknown as { onChunk(c: Buffer): void }).onChunk(chunk);
    expect(got).toHaveLength(2);
    expect(errors).toHaveBeenCalledWith("[%s] %s", "test-kiss", expect.stringContaining("first frame"));
  });

  it("LoRa APRS text lines: the lines after a throwing one are delivered", () => {
    const { got, take } = firstThrows<unknown>();
    const errors: string[] = [];
    const p = new LoraAprsPort(
      {
        host: "127.0.0.1",
        port: 1,
        settings: { ...loraSettings({}), protocol: "text" },
        statsMs: 0,
        log: { log: () => {}, error: (m: string) => errors.push(m) },
      },
      take,
    );
    const link = (p as unknown as { link: { h: { onChunk(c: Buffer): void } } }).link;
    link.h.onChunk(Buffer.from("OE8APR-9>APLRG1:>a\r\nOE8APR-9>APLRG1:>b\r\nOE8APR-9>APLRG1:>c\r\n", "latin1"));
    expect(got).toHaveLength(2);
    expect(errors).toEqual([expect.stringMatching(/^\[lora-aprs\] one received frame was dropped: RangeError/)]);
  });

  it("Meshtastic TCP: the frames after a throwing one are delivered", () => {
    const { got, take } = firstThrows<unknown>();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    cleanups.push(() => errors.mockRestore());
    const tcp = new MeshtasticTcp({ host: "127.0.0.1", port: 1 }, { handle: take } as unknown as MeshtasticIngest);
    const frame = [0x94, 0xc3, 0x00, 0x02, 0x08, 0x01];
    tcp.receive(Uint8Array.from([...frame, ...frame, ...frame]));
    expect(got).toHaveLength(2);
    expect(errors).toHaveBeenCalledWith("[meshtastic] %s", expect.stringMatching(/^one received frame was dropped/));
  });

  it("soundcard modem: the frames after a throwing one are delivered", () => {
    const { got, take } = firstThrows<unknown>();
    const errors: string[] = [];
    const port = new SoundcardPort(
      {
        name: "1",
        device: "plughw:1,0",
        playback: "plughw:1,0",
        rate: 48000,
        tx: false,
        ptt: { kind: "none" },
        txDelayMs: 100,
        txTailMs: 20,
        persist: 255,
        slotTimeMs: 10,
        pttMaxMs: 10_000,
        txLevel: 0.5,
        dutyPct: 100,
      },
      { onPacket: () => {} },
      { master: () => false, calls: [], refusal: () => null },
      { log: () => {}, error: (m) => errors.push(m) },
    );
    const inner = port as unknown as { modem: { push(): unknown[] }; onRxFrame(f: unknown): void };
    inner.modem = { push: () => ["a", "b", "c"] };
    inner.onRxFrame = take;
    port.pushPcm(new Float32Array(8));
    expect(got).toEqual(["b", "c"]);
    expect(errors).toEqual([expect.stringMatching(/^\[soundcard:1\] one received frame was dropped/)]);
  });

  it("MQTT: the packets after a throwing one are delivered", () => {
    const { got, take } = firstThrows<string>();
    const logs = vi.spyOn(console, "log").mockImplementation(() => {});
    cleanups.push(() => logs.mockRestore());
    const m = new MqttSubscriber({ url: "mqtt://127.0.0.1:1", topics: ["t"], name: "test-mqtt" }, (_t, p) =>
      take(new TextDecoder().decode(p)),
    );
    const sub = m as unknown as { sock: unknown; receive(c: Uint8Array, k: number): void };
    sub.sock = { write() {}, destroy() {} };
    const pub = (s: string) => [0x30, ...encodeRemainingLength(3 + s.length), 0x00, 0x01, 0x74, ...Buffer.from(s)];
    sub.receive(Uint8Array.from([...pub("a"), ...pub("b"), ...pub("c")]), 0);
    m.stop();
    expect(got).toEqual(["b", "c"]);
    expect(logs).toHaveBeenCalledWith("[%s] %s", "test-mqtt", expect.stringContaining("first frame"));
  });

  it("MeshCom UDP: a datagram whose consumer throws is logged, and the next is delivered", async () => {
    const { got, take } = firstThrows<unknown>();
    const errors: string[] = [];
    const l = new MeshcomListener(
      { nodes: [{ ip: "127.0.0.1", call: "OE8APR-12" }], bind: "127.0.0.1", port: 0, statsMs: 1e9 },
      take,
      { log: () => {}, warn: () => {}, error: (m: string) => errors.push(m) },
    );
    l.start();
    cleanups.push(() => l.stop());
    const sock = (l as unknown as { sock: dgram.Socket }).sock;
    await new Promise((r) => sock.once("listening", r));
    const to = sock.address().port;
    const client = dgram.createSocket("udp4");
    cleanups.push(() => client.close());
    const msg = (id: string) =>
      JSON.stringify({ src_type: "lora", type: "msg", src: "DH1FR-1", dst: "OE8APR-12", msg: "hi", msg_id: id });
    for (const id of ["A1", "A2"]) await new Promise((r) => client.send(msg(id), to, "127.0.0.1", r));
    const t0 = Date.now();
    while (got.length < 1 && Date.now() - t0 < 3000) await new Promise((r) => setTimeout(r, 10));
    expect(got).toHaveLength(1);
    expect(errors).toEqual([expect.stringMatching(/^\[meshcom\] one received frame was dropped/)]);
  });
});
