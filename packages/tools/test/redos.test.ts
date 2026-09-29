// SPDX-License-Identifier: MIT
// The decoders and the session-script parser read text pasted from or received over the air, so it is
// attacker-controlled: each scan must run in linear time. Every case feeds a long adversarial input and
// requires it to parse well inside a second (a quadratic scan of the same input takes tens of seconds),
// with the result a short input gives.
import { describe, it, expect } from "vitest";
import { decodeMorse } from "../src/decoders/morse.js";
import { decode7plus } from "../src/decoders/sevenplus.js";
import { parseScript } from "../src/session-script.js";

const N = 200_000;

function timed<T>(fn: () => T): { value: T; ms: number } {
  const t0 = performance.now();
  const value = fn();
  return { value, ms: performance.now() - t0 };
}

describe("Morse word splitting", () => {
  it("a long run of spaces between letters decodes fast", () => {
    const { value, ms } = timed(() => decodeMorse(".-" + " ".repeat(N) + "-..."));
    expect(ms).toBeLessThan(1000);
    expect(value).toBe("A B");
  });

  it("keeps the word-gap semantics", () => {
    expect(decodeMorse(".... ..")).toBe("HI");
    expect(decodeMorse(".... .. / -.. .")).toBe("HI DE");
    expect(decodeMorse(".... ..  -.. .")).toBe("HI DE");
    expect(decodeMorse(".-/-...")).toBe("A B");
    expect(decodeMorse(".-  /  -...")).toBe("A B");
    expect(decodeMorse(".- / / -...")).toBe("A  B");
    expect(decodeMorse("  .- /  ")).toBe("A");
    expect(decodeMorse(".-   \t -...")).toBe("A B");
  });
});

describe("7PLUS file name detection", () => {
  it("a long run of '-' before the marker parses fast", () => {
    const { value, ms } = timed(() => decode7plus("-".repeat(N) + " go_7+."));
    expect(ms).toBeLessThan(1000);
    expect(value).toContain("file: (unknown)");
  });

  it("a long word without a marker parses fast", () => {
    const { value, ms } = timed(() => decode7plus(" go_7+.\n" + "a-".repeat(N)));
    expect(ms).toBeLessThan(1000);
    expect(value).toContain("file: (unknown)");
  });

  it("keeps the file-name semantics", () => {
    const file = (s: string) => /file: (.*)/.exec(decode7plus(s))![1];
    expect(file(" go_7+. 001 of 002 TEST.ZIP 0012345 FFFF (7PLUS v2.2)")).toBe("(unknown)");
    expect(file("my-file.zip go_7+. part 1 of 1")).toBe("my-file.zip");
    expect(file("x.y.zip go_7+.")).toBe("y.zip");
    expect(file("a.toolong go_7+.")).toBe("(unknown)");
    expect(file("a.b\n\n GO_7+.")).toBe("a.b");
    expect(file("go_7+.\nfoo.7pl part 3 of 5")).toBe("foo.7pl");
    expect(file("x.a go_7+. y.b go_7+.")).toBe("x.a");
    expect(file("x.toolong go_7+. y.b go_7+.")).toBe("y.b");
    expect(file("go_7+. x.a part 1 of 2 y.b go_7+.")).toBe("y.b");
  });
});

describe("session-script waitfor timeout", () => {
  it("a long run of spaces in a waitfor pattern parses fast", () => {
    const { value, ms } = timed(() => parseScript("waitfor a" + " ".repeat(N) + "b"));
    expect(ms).toBeLessThan(1000);
    expect(value).toEqual([{ op: "waitfor", text: "a" + " ".repeat(N) + "b", timeoutSec: undefined }]);
  });

  it("keeps the timeout semantics", () => {
    expect(parseScript("waitfor Cluster 30")).toEqual([{ op: "waitfor", text: "Cluster", timeoutSec: 30 }]);
    expect(parseScript("waitfor Cluster")).toEqual([{ op: "waitfor", text: "Cluster", timeoutSec: undefined }]);
    expect(parseScript("waitfor a 1 2")).toEqual([{ op: "waitfor", text: "a 1", timeoutSec: 2 }]);
    expect(parseScript("waitfor 42")).toEqual([{ op: "waitfor", text: "42", timeoutSec: undefined }]);
    expect(parseScript("waitfor x\t 7")).toEqual([{ op: "waitfor", text: "x", timeoutSec: 7 }]);
    expect(parseScript("waitfor ab12")).toEqual([{ op: "waitfor", text: "ab12", timeoutSec: undefined }]);
  });
});
