// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { normalizePins, pinnedTool, toolPin, togglePinIn, SHACK_APPS } from "../src/shack/apps.js";
import { toolIcon } from "../src/tools/toolIcons.js";

describe("the rail's pins", () => {
  it("keep app pins and tool pins in the user's order, without duplicates", () => {
    expect(normalizePins(["bbs", "tool:packet-decoder", "terminal", "bbs", "tool:packet-decoder"])).toEqual([
      "bbs",
      "tool:packet-decoder",
      "terminal",
    ]);
  });

  it("drop what names no app and no valid tool", () => {
    expect(normalizePins(["nope", "tool:", "tool:Bad Name", "tool:x", 7, null, "rig"])).toEqual(["rig"]);
    expect(normalizePins("terminal")).toEqual([]);
    expect(normalizePins(null)).toEqual([]);
  });

  it("toggle a pin on at the end and off in place", () => {
    const on = togglePinIn(["bbs"], toolPin("mheard"));
    expect(on).toEqual(["bbs", "tool:mheard"]);
    expect(togglePinIn(on, "bbs")).toEqual(["tool:mheard"]);
  });

  it("name the tool a tool pin stands for", () => {
    expect(pinnedTool(toolPin("packet-decoder"))).toBe("packet-decoder");
    expect(pinnedTool("terminal")).toBeNull();
  });

  it("have no separate packet decoder app: the decoder is a tool", () => {
    expect(SHACK_APPS.map((a) => a.id)).not.toContain("decoder");
    expect(normalizePins(["decoder"])).toEqual([]);
  });

  it("draw a project registry tool with its icon and any other tool with the plug", () => {
    expect(toolIcon("packet-decoder")).toBe("decode");
    expect(toolIcon("someone-elses-tool")).toBe("plug");
  });
});
