// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment jsdom
// A hint describes its control and never joins the control's name, open or closed; and a Field's label names its
// control while the InfoTip beside it keeps its own name.
import { act } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { Field } from "../src/ui/Field.js";
import { Hint, InfoTip } from "../src/ui/Hint.js";
import { accessible, click, render } from "./support/dom.js";

afterEach(() => {
  document.body.innerHTML = "";
});

describe("Hint", () => {
  it("describes a text control without adding to its name, while open", () => {
    render(
      <Hint text="Read and send APRS messages">
        <button type="button">Messages</button>
      </Hint>,
    );
    const b = document.querySelector("button")!;
    act(() => b.focus());
    const tip = document.querySelector("[role=tooltip]")!;
    expect(tip.hasAttribute("data-open")).toBe(true);
    // jsdom has no popover API, so the hint shows the way it does in such a browser: through data-open, with the
    // popover attribute hiding nothing (axe would otherwise take the attribute for a closed popover)
    tip.removeAttribute("popover");
    expect(accessible(b)).toEqual({ name: "Messages", description: "Read and send APRS messages" });
  });
});

describe("Field", () => {
  it("names its control with the label alone, and a tap on the words leaves the InfoTip shut", () => {
    render(
      <Field label="Callsign" info={<InfoTip text="The suffix after the call" label="What is an SSID?" />}>
        {(id) => <input id={id} />}
      </Field>,
    );
    const input = document.querySelector("input")!;
    expect(accessible(input).name).toBe("Callsign");
    expect(accessible(document.querySelector(".infotip")!).name).toBe("What is an SSID?");
    const label = document.querySelector("label")!;
    expect(label.control).toBe(input);
    click(label);
    expect(document.querySelector("[role=tooltip]")!.hasAttribute("data-open")).toBe(false);
  });
});
