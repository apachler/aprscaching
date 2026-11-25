// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment jsdom
// A `?view=tools&tool=<name>` link opens the named tool's row. A tool the user switched off stays off: the link comes
// from whoever wrote it, and switching a tool on runs it with every grant it holds, so that takes the user's own tap.
import { afterEach, describe, expect, it } from "vitest";
import { act } from "react";
import { INSTALLED_KEY } from "../src/tools/installedRecords.js";
import { ToolsPanel } from "../src/tools/ToolsPanel.js";
import { claimTools } from "../src/tools/toolOwner.js";
import { render } from "./support/dom.js";

const record = {
  name: "net-tool",
  title: "Net tool",
  url: "https://tools.example/net-tool/manifest.json",
  pubkey: "A".repeat(43),
  grants: ["network", "monitor"],
  connect: [],
  remote: false,
  on: false,
};

// jsdom lays nothing out, so it has no scrolling to do
Element.prototype.scrollIntoView = function () {};

afterEach(() => {
  document.body.innerHTML = "";
  localStorage.clear();
});

describe("a deep link to an installed tool", () => {
  it("leaves a switched-off tool off and focuses its switch", async () => {
    // the installs belong to this page's identity, so a switch would be written through
    claimTools("N0CALL");
    localStorage.setItem(INSTALLED_KEY, JSON.stringify([record]));
    const view = render(<ToolsPanel callsign="N0CALL" verified={false} tool="net-tool" />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    const stored = JSON.parse(localStorage.getItem(INSTALLED_KEY) ?? "[]") as { name: string; on: boolean }[];
    expect(stored.find((r) => r.name === "net-tool")?.on).toBe(false);
    const sw = document.querySelector('[data-tool="net-tool"] [role="switch"]');
    expect(sw?.getAttribute("aria-checked")).toBe("false");
    expect(document.activeElement).toBe(sw);
    view.unmount();
  });
});
