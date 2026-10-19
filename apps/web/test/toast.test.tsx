// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment jsdom
// Toasts give a reader the time to read them (WCAG 2.2.1): a confirmation stays at least five seconds and longer for
// a longer message, waits while the pointer is on it, and an error stays, announced at once, until it is dismissed.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { act, useEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider, useToast, type ToastOptions } from "../src/ui/Toast.js";
import { click, render } from "./support/dom.js";

function Push(props: { msg: string; opts?: ToastOptions }) {
  const toast = useToast();
  useEffect(() => toast(props.msg, props.opts), [toast, props.msg, props.opts]);
  return null;
}

const shown = () => [...document.querySelectorAll(".toast")].map((t) => t.textContent?.replace("Dismiss", "").trim());
const advance = (ms: number) => act(() => void vi.advanceTimersByTime(ms));

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = "";
});

describe("toasts", () => {
  it("keep a short confirmation for five seconds, then let it go", () => {
    render(
      <ToastProvider>
        <Push msg="Saved" />
      </ToastProvider>,
    );
    advance(4900);
    expect(shown()).toEqual(["Saved"]);
    advance(200);
    expect(shown()).toEqual([]);
  });

  it("keep a long confirmation longer", () => {
    const msg = "Could not open the serial port: the device is in use by another application.";
    render(
      <ToastProvider>
        <Push msg={msg} />
      </ToastProvider>,
    );
    advance(6000);
    expect(shown()).toEqual([msg]);
  });

  it("wait while the pointer is on them", () => {
    render(
      <ToastProvider>
        <Push msg="Saved" />
      </ToastProvider>,
    );
    const stack = document.querySelector(".toasts")!;
    act(() => void stack.dispatchEvent(new PointerEvent("pointerover", { bubbles: true })));
    advance(20_000);
    expect(shown()).toEqual(["Saved"]);
    act(() => void stack.dispatchEvent(new PointerEvent("pointerout", { bubbles: true })));
    advance(5100);
    expect(shown()).toEqual([]);
  });

  it("keep an error, announced as an alert, until it is dismissed", () => {
    render(
      <ToastProvider>
        <Push msg="Could not connect" opts={{ kind: "error" }} />
      </ToastProvider>,
    );
    advance(60_000);
    expect(shown()).toEqual(["Could not connect"]);
    expect(document.querySelector("[role=alert] .toast")).not.toBeNull();
    click(document.querySelector('.toast button[aria-label="Dismiss"]')!);
    expect(shown()).toEqual([]);
  });

  it("show a repeated error once, since errors stay until dismissed", () => {
    function Twice() {
      const toast = useToast();
      return (
        <button type="button" className="fail" onClick={() => toast("Sync failed: offline", { kind: "error" })}>
          sync
        </button>
      );
    }
    render(
      <ToastProvider>
        <Twice />
      </ToastProvider>,
    );
    click(document.querySelector(".fail")!);
    click(document.querySelector(".fail")!);
    click(document.querySelector(".fail")!);
    expect(shown()).toEqual(["Sync failed: offline"]);
  });

  it("keep both live regions rendered while empty, so a screen reader is already watching them", () => {
    render(
      <ToastProvider>
        <span />
      </ToastProvider>,
    );
    const regions = [...document.querySelectorAll(".toast-region")];
    expect(regions.map((r) => r.getAttribute("role"))).toEqual(["alert", "status"]);
    // a live region that is display:none until its first toast is not in the accessibility tree when the toast
    // arrives, and a polite one is then not announced
    const css = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "../src/styles/components/toast.css"),
      "utf8",
    );
    const hiding = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter(
      ([, sel, body]) => /\.toasts?(-region)?\b/.test(sel!) && /display:\s*none|visibility:\s*hidden/.test(body!),
    );
    expect(hiding.map(([, sel]) => sel!.trim())).toEqual([]);
  });
});
