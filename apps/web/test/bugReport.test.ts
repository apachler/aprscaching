// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it, expect } from "vitest";
import { bugReportUrl } from "../src/api.js";

describe("the bug-report link", () => {
  it("opens a GitHub repository's new-issue chooser", () => {
    expect(bugReportUrl("https://github.com/apachler/aprscaching")).toBe(
      "https://github.com/apachler/aprscaching/issues/new/choose",
    );
    expect(bugReportUrl("https://github.com/apachler/aprscaching.git")).toBe(
      "https://github.com/apachler/aprscaching/issues/new/choose",
    );
  });
  it("opens any other forge's repository page", () => {
    expect(bugReportUrl("https://codeberg.org/oe8apr/aprscaching/")).toBe("https://codeberg.org/oe8apr/aprscaching");
  });
});
