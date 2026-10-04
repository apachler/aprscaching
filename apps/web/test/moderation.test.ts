// SPDX-License-Identifier: AGPL-3.0-or-later
// The More menu a viewer gets, the words for kinds and actions, the end of a suspension, and when a reason or
// report dialog lets its answer go.
import { describe, it, expect } from "vitest";
import { menuChoices, kindName, actionName, suspensionUntil, REPORT_CATEGORIES } from "../src/moderation/logic.js";
import { promptProblem } from "../src/ui/Confirm.js";

describe("the More menu", () => {
  it("offers a player Report, and nothing on their own content", () => {
    expect(menuChoices({ sysop: false }).map((c) => c.value)).toEqual(["report"]);
    expect(menuChoices({ sysop: false, own: true })).toEqual([]);
  });
  it("adds Remove for the sysop, and offers Restore alone on a removed cache", () => {
    expect(menuChoices({ sysop: true }).map((c) => c.value)).toEqual(["report", "remove"]);
    expect(menuChoices({ sysop: true, own: true }).map((c) => c.value)).toEqual(["remove"]);
    expect(menuChoices({ sysop: true, removed: true }).map((c) => c.value)).toEqual(["restore"]);
    expect(menuChoices({ sysop: false, removed: true })).toEqual([]);
    expect(menuChoices({ sysop: true }).find((c) => c.value === "remove")?.danger).toBe(true);
  });
});

describe("words", () => {
  it("names kinds and actions, and passes unknown ones through", () => {
    expect(kindName("media")).toBe("photo or file");
    expect(kindName("weird")).toBe("weird");
    expect(actionName("unsuspend")).toBe("lifted the suspension of");
    expect(actionName("other")).toBe("other");
  });
  it("lists the five report categories the server takes", () => {
    expect(REPORT_CATEGORIES.map((c) => c.value)).toEqual(["spam", "offensive", "unsafe", "copyright", "other"]);
  });
});

describe("the end of a suspension", () => {
  const now = Date.UTC(2026, 9, 4, 12);
  it("is open for 'until I lift it' and for nothing picked", () => {
    expect(suspensionUntil("open", now)).toBeNull();
    expect(suspensionUntil(null, now)).toBeNull();
    expect(suspensionUntil("x", now)).toBeNull();
  });
  it("counts days from now", () => {
    expect(suspensionUntil("7", now)).toBe(now / 1000 + 7 * 86_400);
  });
});

describe("a prompt's answer", () => {
  const reason = { title: "t", label: "Reason", minLength: 3, maxLength: 10 };
  it("needs the minimum length, and refuses more than the maximum", () => {
    expect(promptProblem(reason, " ab ", null)).toMatch(/at least 3/);
    expect(promptProblem(reason, "abc", null)).toBeNull();
    expect(promptProblem(reason, "abcdefghijk", null)).toMatch(/10 characters/);
  });
  it("needs the text only for the picks that require it", () => {
    const report = {
      title: "t",
      label: "Details",
      select: { label: "What", options: REPORT_CATEGORIES },
      textRequiredFor: ["other"],
    };
    expect(promptProblem(report, "", "spam")).toBeNull();
    expect(promptProblem(report, "", "other")).toMatch(/few words/);
    expect(promptProblem(report, "it is broken", "other")).toBeNull();
  });
  it("takes an empty optional note", () => {
    expect(promptProblem({ title: "t", label: "Note", maxLength: 500 }, "", null)).toBeNull();
  });
});
