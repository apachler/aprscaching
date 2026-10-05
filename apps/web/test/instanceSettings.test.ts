// SPDX-License-Identifier: AGPL-3.0-or-later
// Instance settings: the control each setting takes, the draft the form edits and the value it submits, the
// search filter, and the words for where a value comes from.
import { describe, it, expect } from "vitest";
import type { SiteSettingView } from "../src/api.js";
import {
  controlKind,
  defaultText,
  draftOf,
  encodeDraft,
  groupStatus,
  isDirty,
  matches,
  sourceBadge,
  submission,
} from "../src/identity/instanceSettings.js";
import { actionName, kindName } from "../src/moderation/logic.js";

const base: SiteSettingView = {
  key: "HIDE_DAILY_LIMIT",
  group: "game",
  label: "Hides per day",
  hint: "New caches one account may hide in 24 hours; 0 lifts the limit",
  type: "int",
  control: null,
  values: null,
  min: 0,
  max: 1000,
  unit: "caches",
  options: null,
  format: null,
  maxLength: null,
  fields: null,
  default: "5",
  value: "5",
  source: "default",
  stored: null,
};
const of = (o: Partial<SiteSettingView>): SiteSettingView => ({ ...base, ...o });

describe("the control of a setting", () => {
  it("follows its type and format", () => {
    expect(controlKind(base)).toBe("number");
    expect(controlKind(of({ key: "UPDATE_CHECK", type: "enum", control: "switch" }))).toBe("switch");
    expect(controlKind(of({ key: "MIN_TRUST", type: "enum", values: ["A", "B"] }))).toBe("choice");
    expect(controlKind(of({ key: "IMPORT_ALLOW", type: "list", options: ["wwff"] }))).toBe("options");
    expect(controlKind(of({ key: "SECURITY_CONTACT", type: "list", format: "contacts" }))).toBe("contacts");
    expect(controlKind(of({ key: "SUPPORT_LINKS", type: "json", format: "links" }))).toBe("links");
    expect(controlKind(of({ key: "RETENTION", type: "json", format: "retention" }))).toBe("retention");
    expect(controlKind(of({ key: "OPERATOR_NAME", type: "string" }))).toBe("text");
  });
});

describe("the draft and what it submits", () => {
  it("checks a number before it is sent, with the gateway's own rule", () => {
    expect(submission(base, "12")).toEqual({ value: "12" });
    expect(submission(base, "-1")).toEqual({ error: "Enter 0 or more." });
    expect(submission(base, "")).toHaveProperty("error");
    expect(isDirty(base, "5")).toBe(false);
    expect(isDirty(base, "6")).toBe(true);
  });

  it("ticks the ids of a list and submits them comma-separated", () => {
    const s = of({ key: "IMPORT_ALLOW", type: "list", options: ["wwff", "gcau", "iota"], value: "wwff" });
    expect(draftOf(s)).toEqual(["wwff"]);
    expect(submission(s, ["iota", "wwff"])).toEqual({ value: "wwff,iota" });
  });

  it("edits contacts without the mailto: prefix and adds it back", () => {
    const s = of({ key: "SECURITY_CONTACT", type: "list", format: "contacts", value: "mailto:sec@example.net" });
    expect(draftOf(s)).toEqual(["sec@example.net"]);
    expect(submission(s, ["sec@example.net", " ", "https://example.net/sec"])).toEqual({
      value: "mailto:sec@example.net,https://example.net/sec",
    });
  });

  it("drops blank link rows and refuses a link without an address", () => {
    const s = of({ key: "SUPPORT_LINKS", type: "json", format: "links", value: null, default: null });
    expect(draftOf(s)).toEqual([]);
    const d = [
      { label: "Liberapay", url: "https://liberapay.com/x" },
      { label: "", url: "" },
    ];
    expect(encodeDraft(s, d)).toBe('[{"label":"Liberapay","url":"https://liberapay.com/x"}]');
    expect(submission(s, [{ label: "Bank", url: "" }])).toHaveProperty("error");
  });

  it("submits only the retention periods filled in", () => {
    const s = of({
      key: "RETENTION",
      type: "json",
      format: "retention",
      value: '{"packetsHours":6}',
      default: null,
      fields: [
        { id: "packetsHours", label: "Raw packets", default: 24, min: 1, max: 8760, unit: "hours" },
        { id: "sensorDays", label: "Weather and telemetry", default: 30, min: 1, max: 3650, unit: "days" },
      ],
    });
    expect(draftOf(s)).toEqual({ packetsHours: "6", sensorDays: "" });
    expect(submission(s, { packetsHours: "6", sensorDays: "90" })).toEqual({
      value: '{"packetsHours":6,"sensorDays":90}',
    });
    expect(submission(s, { packetsHours: "", sensorDays: "" })).toEqual({
      error: "Nothing to save. To go back to the default, use Reset to default.",
    });
  });
});

describe("the search filter", () => {
  it("matches the label, the hint, the key and the group", () => {
    expect(matches(base, "Game rules", "")).toBe(true);
    expect(matches(base, "Game rules", "hides")).toBe(true);
    expect(matches(base, "Game rules", "daily limit")).toBe(true);
    expect(matches(base, "Game rules", "game")).toBe(true);
    expect(matches(base, "Game rules", "imprint")).toBe(false);
  });
});

describe("where a value comes from", () => {
  it("names the source, and the group header counts them", () => {
    expect(sourceBadge(base).text).toBe("Default");
    expect(sourceBadge(of({ source: "site" })).text).toBe("Changed here");
    const env = sourceBadge(of({ source: "env" }));
    expect(env.text).toBe("Set by the environment");
    expect(env.title).toMatch(/HIDE_DAILY_LIMIT/);
    expect(groupStatus([base])).toBe("defaults");
    expect(groupStatus([of({ source: "site" }), of({ source: "env" }), base])).toBe(
      "1 changed here · 1 set by the environment",
    );
  });

  it("shows the default in words", () => {
    expect(defaultText(base)).toBe("5 caches");
    expect(defaultText(of({ control: "switch", type: "enum", default: "1", unit: null }))).toBe("on");
    expect(defaultText(of({ default: null }))).toBe("none");
  });

  it("reads a setting change in the audit log", () => {
    expect(actionName("set")).toBe("changed");
    expect(actionName("reset")).toBe("reset");
    expect(kindName("setting")).toBe("setting");
  });
});
