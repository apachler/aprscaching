// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment jsdom
// The time zone override is typed one key at a time, and the prefixes on the way to a zone are not zones: only
// a blank field or a zone Intl accepts reaches the settings, and the field says when its text is not one yet.
import { createElement, useState } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TimeZoneField } from "../src/identity/TimeZoneField.js";

let root: Root, host: HTMLElement;
let applied: string[] = [];
function Harness() {
  const [tz, setTz] = useState("");
  return createElement(TimeZoneField, {
    value: tz,
    onApply: (v: string) => {
      applied.push(v);
      setTz(v);
    },
  });
}
const input = () => host.querySelector("input")!;
function type(text: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(input(), text);
    input().dispatchEvent(new Event("input", { bubbles: true }));
  });
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  applied = [];
  act(() => root.render(createElement(Harness)));
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("the time zone field", () => {
  it("applies only a known zone while it is typed, and flags the text in between", () => {
    type("E");
    type("Eu");
    expect(applied).toEqual([]);
    expect(input().value).toBe("Eu");
    expect(input().getAttribute("aria-invalid")).toBe("true");
    const msg = document.getElementById(input().getAttribute("aria-describedby")!);
    expect(msg?.textContent).toContain("Europe/Vienna");
    type("Europe/Vienna");
    expect(applied).toEqual(["Europe/Vienna"]);
    expect(input().hasAttribute("aria-invalid")).toBe(false);
  });

  it("applies a cleared field, so the browser's zone applies again", () => {
    type("Europe/Vienna");
    type("");
    expect(applied).toEqual(["Europe/Vienna", ""]);
  });
});
