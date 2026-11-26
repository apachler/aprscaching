// SPDX-License-Identifier: AGPL-3.0-or-later
// The box's log names a feature the gateway serves it nothing for: a BOX_ID with no key of its own, and a packet
// BBS or FBB forwarding on a box that is unkeyed or whose services the sysop has not switched on.
import { describe, it, expect } from "vitest";
import { bbsWarning, boxKeyWarning } from "../src/boxwarnings.js";

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
