// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment jsdom
// The heading outline of a panel has no gaps (axe heading-order): the panel's title is level 2, a settings group's
// title level 3, and a sub-heading inside a group level 4.
import { afterEach, describe, expect, it } from "vitest";
import { Group } from "../src/ui/Group.js";
import { Panel } from "../src/ui/Panel.js";
import { render, violations } from "./support/dom.js";

afterEach(() => {
  document.body.innerHTML = "";
});

describe("panel headings", () => {
  it("are checked by a rule that sees a skipped level", async () => {
    render(
      <Panel title="Filters">
        <h4>Cache type</h4>
      </Panel>,
    );
    expect(await violations(document.body, ["heading-order"])).not.toEqual([]);
  });

  it("step down one level at a time through a group", async () => {
    render(
      <Panel title="Instance admin" onClose={() => {}}>
        <Group title="Partners">
          <h4 className="set-subh">Partners</h4>
          <p>One partner.</p>
        </Group>
        <Group title="Routing">
          <p>No rules.</p>
        </Group>
      </Panel>,
    );
    expect([...document.querySelectorAll("h2, h3")].map((h) => `${h.tagName} ${h.textContent?.trim()}`)).toEqual([
      "H2 Instance admin",
      "H3 ▸ Partners",
      "H3 ▸ Routing",
    ]);
    expect(await violations(document.body, ["heading-order"])).toEqual([]);
  });
});
