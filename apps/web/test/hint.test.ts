// SPDX-License-Identifier: AGPL-3.0-or-later
// When a hint shows and hides: a resting mouse opens it after a delay, keyboard focus at once, a tap never (it is
// the control's own action) unless the control is an InfoTip; moving onto the hint keeps it open, and Escape,
// blur or a second tap closes it.
import { describe, expect, it } from "vitest";
import {
  createHintController,
  hasWords,
  hintAnchor,
  HIDE_DELAY_MS,
  SHOW_DELAY_MS,
  type HintTimers,
} from "../src/ui/hintController.js";

function fakeTimers() {
  let now = 0;
  let seq = 0;
  const due = new Map<number, { at: number; fn: () => void }>();
  const timers: HintTimers = {
    set: (fn, ms) => {
      due.set(++seq, { at: now + ms, fn });
      return seq;
    },
    clear: (h) => void due.delete(h as number),
  };
  const advance = (ms: number) => {
    now += ms;
    for (const [id, t] of [...due].sort((a, b) => a[1].at - b[1].at))
      if (t.at <= now) {
        due.delete(id);
        t.fn();
      }
  };
  return { timers, advance };
}

function setup() {
  const t = fakeTimers();
  const log: string[] = [];
  const c = createHintController({
    onOpen: () => log.push("open"),
    onClose: () => log.push("close"),
    timers: t.timers,
  });
  return { c, log, advance: t.advance };
}

describe("hint controller", () => {
  it("opens after the mouse rests, and not when it passes through", () => {
    const { c, log, advance } = setup();
    c.pointerEnter("mouse");
    advance(SHOW_DELAY_MS - 1);
    c.pointerLeave();
    advance(SHOW_DELAY_MS);
    expect(log).toEqual([]);
    c.pointerEnter("mouse");
    advance(SHOW_DELAY_MS);
    expect(c.isOpen()).toBe(true);
  });

  it("stays open while the pointer crosses onto the hint", () => {
    const { c, log, advance } = setup();
    c.pointerEnter("mouse");
    advance(SHOW_DELAY_MS);
    c.pointerLeave();
    advance(HIDE_DELAY_MS - 1);
    c.pointerEnter("mouse");
    advance(HIDE_DELAY_MS);
    expect(log).toEqual(["open"]);
    c.pointerLeave();
    advance(HIDE_DELAY_MS);
    expect(log).toEqual(["open", "close"]);
  });

  it("ignores a tap, which is the control's own action", () => {
    const { c, log, advance } = setup();
    c.pointerEnter("touch");
    c.focus(false);
    advance(SHOW_DELAY_MS);
    expect(log).toEqual([]);
  });

  it("opens at once on keyboard focus and closes on blur or Escape", () => {
    const { c, log } = setup();
    c.focus(true);
    expect(c.isOpen()).toBe(true);
    c.blur();
    c.focus(true);
    expect(c.escape()).toBe(true);
    expect(c.escape()).toBe(false);
    expect(log).toEqual(["open", "close", "open", "close"]);
  });

  it("a tapped InfoTip stays open until tapped again", () => {
    const { c, advance } = setup();
    c.toggle();
    c.pointerLeave();
    advance(HIDE_DELAY_MS * 2);
    expect(c.isOpen()).toBe(true);
    c.toggle();
    expect(c.isOpen()).toBe(false);
  });
});

describe("hasWords", () => {
  const childrenOf = (n: never) => (n as { children?: unknown }).children;
  it("tells an icon alone from a labelled control", () => {
    expect(hasWords({ children: undefined }, childrenOf)).toBe(false);
    expect(hasWords([{}, " "], childrenOf)).toBe(false);
    expect(hasWords([{}, { children: "Nearby" }], childrenOf)).toBe(true);
    expect(hasWords(3, childrenOf)).toBe(true);
  });
});

it("turns a React id into a CSS anchor name", () => {
  expect(hintAnchor(":r1a:")).toBe("--hint-r1a");
  expect(hintAnchor("«r2»")).toBe("--hint-r2");
});
