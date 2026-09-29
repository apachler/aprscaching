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

  it("keeps the message number semantics: the first '{' after the last '}', with text after it", () => {
    const d = (t: string) => decodeAprs(frame(`:OE8APR   :${t}`)) as { text?: string; msgNo?: string };
    expect(d("hello{12")).toMatchObject({ text: "hello", msgNo: "12" });
    expect(d("a{b{c")).toMatchObject({ text: "a", msgNo: "b{c" });
    expect(d("a}b{c}d{e")).toMatchObject({ text: "a}b{c}d", msgNo: "e" });
    expect(d("hello{")).toMatchObject({ text: "hello{" });
    expect(d("hello{").msgNo).toBeUndefined();
    expect(d("x{}").msgNo).toBeUndefined();
    expect(d("x{{").msgNo).toBe("{");
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
