// SPDX-License-Identifier: MIT
import { describe, expect, it } from "vitest";
import { encodeAx25, kissCommand, kissDecode, kissWrap } from "@aprscaching/aprs";
import { KissClients, parseListeners, parsePortMap } from "../src/clients.js";
import { KissServerCore } from "../src/kissserver.js";

const RADIOS = ["kiss-tnc", "kiss-tnc-1", "soundcard-uhf"];
const frame = (src: string, payload = ">hub") => encodeAx25({ src, dst: "APZACH", payload });

describe("parsePortMap", () => {
  it("maps the box's radio ports in order by default", () => {
    expect(parsePortMap("", RADIOS)).toEqual([
      { kiss: 0, radio: "kiss-tnc" },
      { kiss: 1, radio: "kiss-tnc-1" },
      { kiss: 2, radio: "soundcard-uhf" },
    ]);
  });

  it("takes explicit numbers, and a bare entry's place in the list", () => {
    expect(parsePortMap("soundcard-uhf, 5=kiss-tnc", RADIOS)).toEqual([
      { kiss: 0, radio: "soundcard-uhf" },
      { kiss: 5, radio: "kiss-tnc" },
    ]);
  });

  it("refuses an unknown radio port, a number outside 0-15 and a duplicate", () => {
    expect(() => parsePortMap("lora-aprs", RADIOS)).toThrow(/not a radio port/);
    expect(() => parsePortMap("16=kiss-tnc", RADIOS)).toThrow(/not 0-15/);
    expect(() => parsePortMap("0=kiss-tnc,kiss-tnc-1,0=soundcard-uhf", RADIOS)).toThrow(/mapped twice/);
    expect(() => parsePortMap("kiss-tnc,3=kiss-tnc", RADIOS)).toThrow(/mapped twice/);
  });
});

describe("parseListeners", () => {
  const map = parsePortMap("", RADIOS);
  it("reads <tcp port>=<kiss port> entries", () => {
    expect(parseListeners("8102=1, 8103=2", map)).toEqual([
      { tcpPort: 8102, kiss: 1 },
      { tcpPort: 8103, kiss: 2 },
    ]);
  });

  it("refuses an unmapped KISS port, a bad TCP port and a malformed entry", () => {
    expect(() => parseListeners("8102=9", map)).toThrow(/not mapped/);
    expect(() => parseListeners("70000=1", map)).toThrow(/1-65535/);
    expect(() => parseListeners("8102", map)).toThrow(/<tcp port>=<kiss port>/);
    expect(() => parseListeners("8102=1,8102=2", map)).toThrow(/twice/);
  });
});

describe("KissClients", () => {
  const map = parsePortMap("", RADIOS);
  it("sends a hearing to every client that sees the port, on its own number", () => {
    const c = new KissClients<string>(map, 8);
    c.add("all");
    c.add("uhf-only", 2);
    c.add("vhf1-only", 1);
    const f = frame("OE8APR-7");
    const out = c.heard("soundcard-uhf", f);
    expect(out.map((d) => d.conn)).toEqual(["all", "uhf-only"]);
    expect(kissDecode(out[0]!.bytes)[0]).toEqual({ port: 2, command: 0, frame: f });
    expect(kissDecode(out[1]!.bytes)[0]).toEqual({ port: 0, command: 0, frame: f });
  });

  it("maps a client's KISS port back to the radio port it sees by that number", () => {
    const c = new KissClients<string>(map, 8);
    c.add("all");
    c.add("one", 1);
    expect(c.radioFor("all", 1)).toBe("kiss-tnc-1");
    expect(c.radioFor("one", 0)).toBe("kiss-tnc-1");
    expect(c.radioFor("one", 1)).toBeNull();
  });

  it("refuses a client past the limit", () => {
    const c = new KissClients<string>(map, 1);
    expect(c.add("a")).toBe(true);
    expect(c.add("b")).toBe(false);
    c.remove("a");
    expect(c.add("b")).toBe(true);
  });
});

describe("KissServerCore", () => {
  const map = parsePortMap("", RADIOS);

  it("refuses every client frame while transmit is off", () => {
    const s = new KissServerCore<string>({ map, maxClients: 4, tx: false, txCalls: ["OE8APR"] });
    s.connect("a");
    expect(s.receive("a", kissWrap(frame("OE8APR-7")))).toEqual([]);
    expect(s.read("a").refused).toEqual({ "tx-off": 1 });
    expect(s.waiting()).toEqual([]);
  });

  it("queues a frame from a listed base call for the radio port the client means", () => {
    const s = new KissServerCore<string>({ map, maxClients: 4, tx: true, txCalls: ["oe8apr-10"] });
    s.connect("a");
    s.connect("b", 2);
    const f = frame("OE8APR-7");
    expect(s.receive("a", kissWrap(f, 1))).toEqual(["kiss-tnc-1"]);
    expect(s.receive("b", kissWrap(f, 0))).toEqual(["soundcard-uhf"]);
    expect(s.next("kiss-tnc-1")).toEqual({ client: "a", frame: f, call: "OE8APR" });
    expect(s.next("soundcard-uhf")).toEqual({ client: "b", frame: f, call: "OE8APR" });
  });

  it("drops a frame from an unlisted call, on an unseen port, or with no address field, and counts each", () => {
    const s = new KissServerCore<string>({ map, maxClients: 4, tx: true, txCalls: ["OE8APR"] });
    s.connect("a", 1);
    s.receive(
      "a",
      Uint8Array.from([
        ...kissWrap(frame("OE1XYZ")),
        ...kissWrap(frame("OE8APR"), 1),
        ...kissWrap(new Uint8Array(20).fill(0x41)),
        ...kissCommand(1, 40),
      ]),
    );
    expect(s.read("a")).toMatchObject({ refused: { call: 1, port: 1, invalid: 1 }, commands: 1, queued: 0 });
    expect(s.waiting()).toEqual([]);
  });

  it("counts budget refusals, gate refusals and forgets a client's frames when it disconnects", () => {
    const s = new KissServerCore<string>({
      map,
      maxClients: 4,
      tx: true,
      txCalls: ["OE8APR"],
      arbiter: { framesPerMinute: 2 },
    });
    s.connect("a");
    s.receive(
      "a",
      Uint8Array.from([...kissWrap(frame("OE8APR")), ...kissWrap(frame("OE8APR")), ...kissWrap(frame("OE8APR"))]),
    );
    s.gateRefused("a");
    expect(s.read("a")).toMatchObject({ queued: 2, refused: { "frame-budget": 1, gate: 1 } });
    const counts = s.disconnect("a");
    expect(counts.queued).toBe(2);
    expect(s.next("kiss-tnc")).toBeNull();
    expect(s.receive("a", kissWrap(frame("OE8APR")))).toEqual([]);
  });
});
