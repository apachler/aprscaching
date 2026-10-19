// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment jsdom
// The prerendered landing is usable before the app's JavaScript has run: every call to action is a form that a tap
// submits without it, and when the app's own landing replaces that copy the visitor keeps the callsign they typed,
// where they had scrolled to, and the field they were typing in.
import { afterEach, describe, expect, it } from "vitest";
import { render as renderLanding } from "../src/landingPrerender.js";
import { takeOverLanding } from "../src/landingTakeover.js";

afterEach(() => {
  document.body.innerHTML = "";
});

/** jsdom lays nothing out, so a scroll offset is a plain property here. */
function scrollable(el: Element) {
  let top = 0;
  Object.defineProperty(el, "scrollTop", { get: () => top, set: (v: number) => (top = v), configurable: true });
}

function mount() {
  const html = renderLanding();
  document.body.innerHTML = `<div id="landing-pre">${html}</div><div id="root">${html}</div>`;
  const pre = document.getElementById("landing-pre")!;
  const root = document.getElementById("root")!;
  for (const l of document.querySelectorAll(".landing")) scrollable(l);
  return { pre, root };
}

describe("prerendered landing", () => {
  it("submits every call to action as a form", () => {
    const html = renderLanding();
    // the HTML parser ends a paragraph at a form, which would leave the prerendered copy unlike the app's
    expect(html).not.toMatch(/<p\b(?:(?!<\/p>).)*<form/s);
    document.body.innerHTML = html;
    const named = (text: string) =>
      [...document.querySelectorAll("button")].filter((b) => b.textContent?.trim() === text);
    const ctas = [...named("Sign in"), ...named("Join with your callsign"), ...named("Explore the live map")];
    expect(ctas).toHaveLength(4);
    for (const b of ctas) {
      expect(b.type).toBe("submit");
      expect(b.form?.getAttribute("action")).toMatch(/^\//);
    }
    // a form to the front page opens the platform, which a bare `/` would not
    for (const b of named("Explore the live map")) expect(new FormData(b.form!).get("view")).toBe("map");
    for (const b of [...named("Sign in"), ...named("Join with your callsign")])
      expect(b.form!.getAttribute("action")).toBe("/join");
  });

  it("hands the typed callsign, the scroll offset and the focus to the app's landing", () => {
    const { pre, root } = mount();
    const typed = pre.querySelector<HTMLInputElement>("#landing-call")!;
    typed.value = "OE8A";
    typed.focus();
    typed.setSelectionRange(2, 2);
    pre.querySelector(".landing")!.scrollTop = 400;

    takeOverLanding(pre, root);

    expect(document.getElementById("landing-pre")).toBeNull();
    const field = root.querySelector<HTMLInputElement>("#landing-call")!;
    expect(field.value).toBe("OE8A");
    expect(document.activeElement).toBe(field);
    expect(field.selectionStart).toBe(2);
    expect(root.querySelector(".landing")!.scrollTop).toBe(400);
  });

  it("leaves a callsign the app's landing already holds, and the focus where it is", () => {
    const { pre, root } = mount();
    pre.querySelector<HTMLInputElement>("#landing-call")!.value = "OE8A";
    root.querySelector<HTMLInputElement>("#landing-call")!.value = "OE8APR";
    takeOverLanding(pre, root);
    expect(root.querySelector<HTMLInputElement>("#landing-call")!.value).toBe("OE8APR");
    expect(document.activeElement).toBe(document.body);
  });
});
