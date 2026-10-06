// SPDX-License-Identifier: AGPL-3.0-or-later
// The Activity feed reads each log with its own verb, never "found" for a did-not-find or a note.
import { describe, expect, it } from "vitest";
import { LogType } from "@aprscaching/shared";
import { activityBadge, activityVerb } from "../src/activity/verbs.js";

describe("activity verbs", () => {
  it("give each log type its own verb", () => {
    expect(activityVerb("found")).toBe("found");
    expect(activityVerb("dnf")).toBe("didn't find");
    expect(activityVerb("note")).toBe("wrote a note on");
    expect(activityVerb("maintenance")).toBe("did maintenance on");
  });

  it("know every log type the game has, and fall back to a neutral verb", () => {
    for (const t of LogType.options) expect(activityVerb(t)).not.toBe("logged");
    expect(activityVerb("something-new")).toBe("logged");
  });

  it("label a did-not-find as DNF", () => {
    expect(activityBadge("dnf")).toBe("DNF");
    expect(activityBadge("note")).toBe("note");
  });
});
