// SPDX-License-Identifier: AGPL-3.0-or-later
// The box's log names a feature the gateway serves it nothing for: a BOX_ID with no key of its own, and a packet
// BBS or FBB forwarding on a box that is unkeyed or whose services the sysop has not switched on.
import { readFileSync } from "node:fs";
import { describe, it, expect, vi, afterEach } from "vitest";
import { bbsWarning, boxKeyWarning, warnAtStart, warnOnCheck } from "../src/boxwarnings.js";

describe("the box's key", () => {
  it("warns when BOX_ID is set without BOX_KEY: no remote control and no radio replies through it", () => {
    expect(boxKeyWarning({ BOX_ID: "pi-home" })).toMatch(
      /^\[box\] remote control and radio replies are off: BOX_ID is set, but the box has no key of its own \(BOX_KEY\)/,
    );
  });
  it("says nothing for an enrolled box or a box without remote control", () => {
    expect(boxKeyWarning({ BOX_ID: "pi-home", BOX_KEY: "k" })).toBeNull();
    expect(boxKeyWarning({})).toBeNull();
  });
});

describe("the packet BBS and FBB forwarding", () => {
  const unkeyed = /^\[bbs\] the packet BBS and FBB forwarding answer no mail: the box has no key of its own/;
  const servicesOff = /^\[bbs\] .*this box does not\. Switch on Runs this instance's services for pi-home/;

  it("warns on an unkeyed box, whatever the gateway says", () => {
    expect(bbsWarning({ BBS_NODE_CALL: "OE8APR-8" })).toMatch(unkeyed);
    expect(bbsWarning({ BBS_FORWARD: "1" }, true)).toMatch(unkeyed);
  });
  it("warns on a keyed box whose services are off", () => {
    const env = { BBS_NODE_CALL: "OE8APR-8", BOX_ID: "pi-home", BOX_KEY: "k" };
    expect(bbsWarning(env, false)).toMatch(servicesOff);
    expect(bbsWarning({ ...env, BBS_NODE_CALL: undefined, BBS_FORWARD: "1" }, false)).toMatch(servicesOff);
  });
  it("says nothing on a keyed box whose services are on or not known yet, or without a BBS", () => {
    const env = { BBS_NODE_CALL: "OE8APR-8", BOX_ID: "pi-home", BOX_KEY: "k" };
    expect(bbsWarning(env, true)).toBeNull();
    expect(bbsWarning(env)).toBeNull();
    expect(bbsWarning(env, null)).toBeNull();
    expect(bbsWarning({ BOX_ID: "pi-home" }, false)).toBeNull();
  });
});

describe("what the box prints", () => {
  // the start path and learnServiceCall() call these with their default printer, console.warn
  const printed = () => vi.spyOn(console, "warn").mockImplementation(() => {});
  afterEach(() => vi.restoreAllMocks());

  it("prints at start the BOX_ID-without-key warning and the unkeyed box's BBS warning", () => {
    const warn = printed();
    warnAtStart({ BOX_ID: "pi-home", BBS_NODE_CALL: "OE8APR-8" });
    expect(warn.mock.calls.map((c) => c[0])).toEqual([
      expect.stringMatching(/^\[bbs\] the packet BBS and FBB forwarding answer no mail: the box has no key of its own/),
      expect.stringMatching(/^\[box\] remote control and radio replies are off/),
    ]);
  });

  it("prints nothing at start for an enrolled box", () => {
    const warn = printed();
    warnAtStart({ BOX_ID: "pi-home", BOX_KEY: "k", BBS_NODE_CALL: "OE8APR-8" });
    expect(warn).not.toHaveBeenCalled();
  });

  it("prints the services-off warning for a keyed box once, when the gateway's check reports it", () => {
    const warn = printed();
    const env = { BOX_ID: "pi-home", BOX_KEY: "k", BBS_NODE_CALL: "OE8APR-8" };
    const warned = new Set<string>();
    warnOnCheck(env, true, warned);
    expect(warn).not.toHaveBeenCalled();
    warnOnCheck(env, false, warned);
    warnOnCheck(env, false, warned);
    expect(warn.mock.calls.map((c) => c[0])).toEqual([
      expect.stringMatching(/this box does not\. Switch on Runs this instance's services for pi-home/),
    ]);
  });

  it("leaves an unkeyed box's BBS warning to the start", () => {
    const warn = printed();
    warnOnCheck({ BBS_NODE_CALL: "OE8APR-8" }, null, new Set());
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("the ingest box's start path", () => {
  // index.ts runs the whole box on import, so its calls are read from the source: the prints above happen only
  // through these two calls
  const src = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  it("prints the start warnings and the check's services warning", () => {
    expect(src).toMatch(/^warnAtStart\(env\);$/m);
    expect(src).toMatch(/^\s+warnOnCheck\(env, services, callWarned\);$/m);
  });
});
