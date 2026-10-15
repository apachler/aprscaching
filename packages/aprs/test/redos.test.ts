// SPDX-License-Identifier: MIT
// Radio and APRS-IS payloads are attacker-controlled: every text scan in the decoder must run in
// linear time, so a crafted frame cannot stall the ingest. Each case feeds a long adversarial payload
// and requires it to decode well inside a second (a quadratic scan of the same input takes tens of
// seconds), with the same result a short payload gives.
import { describe, it, expect } from "vitest";
import { decodeAprs } from "../src/decode.js";

const frame = (payload: string) => ({ src: "OE8APR", dst: "APRS", path: [] as string[], payload, raw: "" });
const N = 200_000;

function timed<T>(fn: () => T): { value: T; ms: number } {
  const t0 = performance.now();
  const value = fn();
  return { value, ms: performance.now() - t0 };
}

describe("message number scan is linear", () => {
  it("a message body of many '{' followed by '}' decodes fast and carries no message number", () => {
    const { value, ms } = timed(() => decodeAprs(frame(`:OE8APR   :${"{".repeat(N)}}`)) as { msgNo?: string });
    expect(ms).toBeLessThan(1000);
    expect(value.msgNo).toBeUndefined();
  });

  it("reads the message number as 1–5 alphanumerics after the last '{' at the end of the text", () => {
    const d = (t: string) => decodeAprs(frame(`:OE8APR   :${t}`)) as { text?: string; msgNo?: string };
    expect(d("hello{12")).toMatchObject({ text: "hello", msgNo: "12" });
    expect(d("a{b{c")).toMatchObject({ text: "a{b", msgNo: "c" });
    expect(d("a}b{c}d{e")).toMatchObject({ text: "a}b{c}d", msgNo: "e" });
    expect(d("hello{")).toMatchObject({ text: "hello{" });
    expect(d("hello{").msgNo).toBeUndefined();
    expect(d("x{}").msgNo).toBeUndefined();
    expect(d("x{{").msgNo).toBeUndefined(); // a message number is 1–5 alphanumerics
  });
});

describe("telemetry scan is linear", () => {
  it("a long digit run followed by a line break decodes fast", () => {
    const { value, ms } = timed(() => decodeAprs(frame(`T#${"0".repeat(N)}\nx`)) as { analog?: number[] });
    expect(ms).toBeLessThan(1000);
    expect(value).toEqual({ kind: "telemetry", analog: [], digital: [] });
  });

  it("keeps the telemetry field semantics", () => {
    const d = (p: string) => decodeAprs(frame(p));
    expect(d("T#005,199,000,255,073,123,01101001")).toEqual({
      kind: "telemetry",
      seq: 5,
      analog: [199, 0, 255, 73, 123],
      digital: [false, true, true, false, true, false, false, true],
    });
    expect(d("T#MIC199,000")).toMatchObject({ kind: "telemetry", seq: undefined });
    expect(d("T005,1,2")).toMatchObject({ seq: 5, analog: [1, 2] });
    expect(d("T#12\r")).toEqual({ kind: "telemetry", analog: [], digital: [] });
  });
});

describe("data extension scan is linear", () => {
  const pos = "!4903.50N/07201.75W";
  it("long runs after a PHG, RNG, DFS or DF bearing head decode fast", () => {
    for (const payload of [
      `${pos}#PHG${"5".repeat(N)}`,
      `${pos}#PHG513${"0/".repeat(N)}`,
      `${pos}#RNG${"0".repeat(N)}`,
      `${pos}\\DFS${"2".repeat(N)}`,
      `${pos}\\000/000${"/".repeat(N)}`,
      `${pos}\\000/000/${"9".repeat(N)}`,
    ]) {
      const { ms } = timed(() => decodeAprs(frame(payload)));
      expect(ms).toBeLessThan(1000);
    }
  });

  it("keeps the extension semantics", () => {
    const d = (p: string) => decodeAprs(frame(p)) as { phg?: unknown; rangeKm?: number; df?: unknown };
    expect(d(`${pos}#PHG5132`).phg).toEqual({ powerW: 25, heightM: 6.1, gainDb: 3, directivityDeg: 90 });
    expect(d(`${pos}#RNG0050`).rangeKm).toBe(80.5);
    expect(d(`${pos}\\000/000/270/729`).df).toEqual({ bearingDeg: 270, hits: 7, rangeKm: 6.4, accuracyDeg: 1 });
  });
});
