// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment jsdom
// Escape closes the innermost surface only: a modal opened from a panel (the compass, the tool permission prompt)
// closes without the panel around it, and an open suggestion list inside a sheet closes before the sheet does.
import { useRef } from "react";
import { createPortal } from "react-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Panel } from "../src/ui/Panel.js";
import { Sheet } from "../src/ui/Sheet.js";
import { useModalDialog } from "../src/ui/useModalDialog.js";
import { press, render } from "./support/dom.js";

function PortalDialog(props: { onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useModalDialog(ref, props.onClose);
  return createPortal(
    <div ref={ref} role="dialog" aria-modal="true" aria-label="Inner">
      <button type="button">Inside</button>
    </div>,
    document.body,
  );
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("Escape in nested surfaces", () => {
  it("closes a portalled modal without the panel that opened it", () => {
    const panelClose = vi.fn();
    const dialogClose = vi.fn();
    render(
      <Panel title="Cache" onClose={panelClose}>
        <PortalDialog onClose={dialogClose} />
      </Panel>,
    );
    press(document.querySelector('[aria-label="Inner"] button')!, "Escape");
    expect(dialogClose).toHaveBeenCalledTimes(1);
    expect(panelClose).not.toHaveBeenCalled();
  });

  it("closes an inline modal without the panel around it", () => {
    const panelClose = vi.fn();
    const dialogClose = vi.fn();
    function Inline() {
      const ref = useRef<HTMLDivElement>(null);
      useModalDialog(ref, dialogClose);
      return (
        <div ref={ref} aria-label="Prompt">
          <button type="button">Approve</button>
        </div>
      );
    }
    render(
      <Panel title="Tools" onClose={panelClose}>
        <Inline />
      </Panel>,
    );
    press(document.querySelector('[aria-label="Prompt"] button')!, "Escape");
    expect(dialogClose).toHaveBeenCalledTimes(1);
    expect(panelClose).not.toHaveBeenCalled();
  });

  it("leaves an open combobox's list to close first, then closes the sheet", () => {
    const sheetClose = vi.fn();
    const { rerender } = render(
      <Sheet title="Search" edge="top" onClose={sheetClose}>
        <input role="combobox" aria-expanded="true" aria-controls="x" />
      </Sheet>,
    );
    press(document.querySelector("input")!, "Escape");
    expect(sheetClose).not.toHaveBeenCalled();
    rerender(
      <Sheet title="Search" edge="top" onClose={sheetClose}>
        <input role="combobox" aria-expanded="false" aria-controls="x" />
      </Sheet>,
    );
    press(document.querySelector("input")!, "Escape");
    expect(sheetClose).toHaveBeenCalledTimes(1);
  });
});
