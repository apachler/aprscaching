// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startPoll } from "../src/ui/usePoll.js";

/** A document stand-in: `hidden` plus visibilitychange events. */
class FakeDoc extends EventTarget {
  hidden = false;
  setHidden(h: boolean) {
    this.hidden = h;
    this.dispatchEvent(new Event("visibilitychange"));
  }
}

describe("startPoll", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("runs at once and then every interval", () => {
    const fn = vi.fn();
    const stop = startPoll(fn, 1000, new FakeDoc());
    expect(fn).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(3000);
    expect(fn).toHaveBeenCalledTimes(4);
    stop();
  });

  it("can wait one interval before the first run", () => {
    const fn = vi.fn();
    const stop = startPoll(fn, 1000, new FakeDoc(), { immediate: false });
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(fn).toHaveBeenCalledTimes(1);
    stop();
  });

  it("pauses while the document is hidden and refreshes once on return", () => {
    const doc = new FakeDoc();
    const fn = vi.fn();
    const stop = startPoll(fn, 1000, doc);
    doc.setHidden(true);
    vi.advanceTimersByTime(10_000);
    expect(fn).toHaveBeenCalledTimes(1);
    doc.setHidden(false);
    expect(fn).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(1000);
    expect(fn).toHaveBeenCalledTimes(3);
    stop();
  });

  it("starts paused when the document is already hidden", () => {
    const doc = new FakeDoc();
    doc.hidden = true;
    const fn = vi.fn();
    const stop = startPoll(fn, 1000, doc);
    vi.advanceTimersByTime(5000);
    expect(fn).not.toHaveBeenCalled();
    doc.setHidden(false);
    expect(fn).toHaveBeenCalledTimes(1);
    stop();
  });

  it("stops for good: no timer and no visibility listener after cleanup", () => {
    const doc = new FakeDoc();
    const fn = vi.fn();
    const stop = startPoll(fn, 1000, doc);
    stop();
    vi.advanceTimersByTime(5000);
    doc.setHidden(true);
    doc.setHidden(false);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("hands every run a signal that aborts when polling stops", () => {
    const signals: AbortSignal[] = [];
    const stop = startPoll((s) => signals.push(s), 1000, new FakeDoc());
    vi.advanceTimersByTime(1000);
    expect(signals.length).toBe(2);
    expect(signals.every((s) => !s.aborted)).toBe(true);
    stop();
    expect(signals.every((s) => s.aborted)).toBe(true);
  });

  it("polls without a document (no visibility API)", () => {
    const fn = vi.fn();
    const stop = startPoll(fn, 500, undefined);
    vi.advanceTimersByTime(1000);
    expect(fn).toHaveBeenCalledTimes(3);
    stop();
  });
});
