// SPDX-License-Identifier: AGPL-3.0-or-later
// Rendering for the component tests that run under jsdom: mount a tree, fire native events inside act(), and read
// accessible names and descriptions through axe-core's own computation, so a test asserts what assistive tech gets.
import axe from "axe-core";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

export function render(node: ReactNode) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  act(() => root.render(node));
  return {
    host,
    rerender: (next: ReactNode) => act(() => root.render(next)),
    unmount: () => {
      act(() => root.unmount());
      host.remove();
    },
  };
}

/** A native keydown that bubbles, the way a browser delivers one. */
export function press(el: Element, key: string) {
  act(() => {
    el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  });
}

export function click(el: Element) {
  act(() => {
    (el as HTMLElement).click();
  });
}

/** The accessible name and description axe computes for an element. */
export function accessible(el: Element): { name: string; description: string } {
  axe.setup(document);
  try {
    const v = axe.utils.getNodeFromTree(el)!;
    const name = axe.commons.text.accessibleTextVirtual(v).trim();
    const ids = (el.getAttribute("aria-describedby") ?? "").split(/\s+/).filter(Boolean);
    const description = ids
      .map((id) => document.getElementById(id))
      .filter((n): n is HTMLElement => !!n)
      .map((n) => axe.commons.text.accessibleTextVirtual(axe.utils.getNodeFromTree(n)!, { inLabelledByContext: true }))
      .join(" ")
      .trim();
    return { name, description };
  } finally {
    axe.teardown();
  }
}

/** axe's violations for the given rules inside `el`. */
export async function violations(el: Element, rules: string[]): Promise<string[]> {
  const r = await axe.run(el, { runOnly: { type: "rule", values: rules } });
  return r.violations.flatMap((v) => v.nodes.map((n) => `${v.id}: ${n.target.join(" ")}`));
}
