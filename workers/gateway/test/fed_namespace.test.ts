// SPDX-License-Identifier: AGPL-3.0-or-later
// A federated global id belongs to exactly one instance (its `<instance>:` namespace). The record
// signature covers {type,id,data} but NOT `signer`/namespace, so without this gate a peer could
// serve a record — or a tombstone — targeting ANOTHER instance's namespace, signed with its own
// key, and overwrite that instance's genuine mirror or censor its records.
import { describe, it, expect } from "vitest";
import { idInNamespace } from "../src/fedapply.js";

describe("id namespace ownership", () => {
  it("accepts an id in the serving peer's own namespace", () => {
    expect(idInNamespace("oe.peer.net:cache:5", "oe.peer.net")).toBe(true);
    expect(idInNamespace("oe.peer.net:find:9", "oe.peer.net")).toBe(true);
    expect(idInNamespace("oe.peer.net:tombstone:2", "oe.peer.net")).toBe(true);
  });

  it("rejects an id in ANOTHER instance's namespace (origin spoof / overwrite)", () => {
    expect(idInNamespace("victim.net:cache:1", "oe.peer.net")).toBe(false); // serving peer.net, claiming victim.net
    expect(idInNamespace("victim.net:find:1", "oe.peer.net")).toBe(false);
  });

  it("rejects a cross-namespace tombstone target (censorship)", () => {
    // a hostile peer emitting a tombstone whose targetId is the victim's record
    expect(idInNamespace("victim.net:cache:42", "hostile.net")).toBe(false);
  });

  it("is not fooled by a prefix that isn't a namespace boundary", () => {
    expect(idInNamespace("oe.peer.net.evil:cache:1", "oe.peer.net")).toBe(false); // must match up to the ':'
    expect(idInNamespace("oe.peer:cache:1", "oe.peer.net")).toBe(false);
  });

  it("rejects empty / missing ids", () => {
    expect(idInNamespace(undefined, "oe.peer.net")).toBe(false);
    expect(idInNamespace(null, "oe.peer.net")).toBe(false);
    expect(idInNamespace("", "oe.peer.net")).toBe(false);
  });
});

describe("isInstanceId", () => {
  it("accepts lowercase hostnames and refuses anything that could claim another namespace", async () => {
    const { isInstanceId } = await import("../src/federation.js");
    for (const ok of ["oe.pub", "a.example", "x-1.b2.example", "localhost"]) expect(isInstanceId(ok)).toBe(true);
    for (const bad of [
      "b.example:cache",
      "",
      "A.example",
      "-a.example",
      "a-.example",
      "a..example",
      "a.example.",
      "a b",
      7,
    ])
      expect(isInstanceId(bad)).toBe(false);
    expect(isInstanceId("a".repeat(64))).toBe(false);
    expect(isInstanceId(`${"a".repeat(60)}.`.repeat(5))).toBe(false);
  });

  it("answers in linear time on long adversarial input", async () => {
    const { isInstanceId } = await import("../src/federation.js");
    const t = Date.now();
    for (let i = 0; i < 1000; i++) isInstanceId("a-".repeat(126) + "!");
    expect(Date.now() - t).toBeLessThan(500);
  });
});
