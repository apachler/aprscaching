// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { CONFIG_KEYS, type ConfigKey } from "../src/config.js";
import { SITE_GROUP_TITLES, SITE_TEXT } from "../src/configdocs.js";
import { RETENTION_FIELDS, SITE_SETTING_KEYS, checkSiteValue, isFlagKey } from "../src/sitesettings.js";

describe("the site settings of the schema", () => {
  it("are gateway policy only: never a secret, an address, an identity or a server knob", () => {
    expect(SITE_SETTING_KEYS.length).toBeGreaterThan(10);
    for (const k of SITE_SETTING_KEYS) {
      const c: ConfigKey = CONFIG_KEYS[k];
      expect(c.secret, k).toBeFalsy();
      // the gateway reads it on each use; no server process, ingest box or deploy script reads it at start
      expect(c.units, k).toContain("gateway");
      for (const u of ["server", "ingest", "deploy", "desktop"] as const) expect(c.units, k).not.toContain(u);
    }
    for (const k of ["APP_URL", "EXTRA_ORIGINS", "RP_ID", "INSTANCE", "ADMIN_CALLSIGNS", "SERVICE_CALL", "DB_PATH"])
      expect(SITE_SETTING_KEYS as string[], k).not.toContain(k);
  });

  it("give every number its bounds, every key a label and every group a title", () => {
    for (const k of SITE_SETTING_KEYS) {
      const c: ConfigKey = CONFIG_KEYS[k];
      if (c.type === "int" || c.type === "number") {
        expect(c.site!.min, k).toBeDefined();
        expect(c.site!.max, k).toBeDefined();
        if (c.default !== undefined) expect(checkSiteValue(k, c.default), k).toEqual({ value: c.default });
      }
      expect(SITE_TEXT[k].label.length, k).toBeGreaterThan(2);
      expect(SITE_GROUP_TITLES[c.site!.group], k).toBeTruthy();
    }
  });

  it("show the on/off enums as switches", () => {
    expect(isFlagKey("UPDATE_CHECK")).toBe(true);
    expect(isFlagKey("SPOTS_ENABLED")).toBe(true);
    expect(isFlagKey("MIN_TRUST")).toBe(false);
  });
});

describe("checkSiteValue", () => {
  it("normalises numbers and refuses them outside their bounds", () => {
    expect(checkSiteValue("HIDE_DAILY_LIMIT", " 07 ")).toEqual({ value: "7" });
    expect(checkSiteValue("CACHE_MOVE_LIMIT_M", "12.5")).toEqual({ value: "12.5" });
    expect(checkSiteValue("HIDE_DAILY_LIMIT", "1.5")).toEqual({ error: "Enter a whole number." });
    expect(checkSiteValue("HIDE_DAILY_LIMIT", "-1")).toEqual({ error: "Enter 0 or more." });
    expect(checkSiteValue("MODERATION_RETENTION_DAYS", "99999")).toEqual({ error: "Enter 3650 or less." });
  });

  it("refuses a blank value and a value that is not text", () => {
    expect(checkSiteValue("OPERATOR_NAME", "  ")).toHaveProperty("error");
    expect(checkSiteValue("HIDE_DAILY_LIMIT", 5)).toHaveProperty("error");
  });

  it("takes only the known ids of a list, in their own order", () => {
    expect(checkSiteValue("IMPORT_ALLOW", "IOTA,wwff,wwff")).toEqual({ value: "wwff,iota" });
    expect(checkSiteValue("IMPORT_ALLOW", "osm")).toEqual({ error: "osm is not one of: wwff, gcau, iota." });
    expect(checkSiteValue("SPOTS_SOURCES", "sota, pota")).toEqual({ value: "pota,sota" });
  });

  it("checks contact addresses, email and one-line text", () => {
    expect(checkSiteValue("SECURITY_CONTACT", "a@b.example, mailto:c@d.example")).toEqual({
      value: "mailto:a@b.example,mailto:c@d.example",
    });
    expect(checkSiteValue("SECURITY_CONTACT", "ftp://x.example")).toHaveProperty("error");
    expect(checkSiteValue("OPERATOR_EMAIL", "op@example.net")).toEqual({ value: "op@example.net" });
    expect(checkSiteValue("OPERATOR_EMAIL", "op")).toHaveProperty("error");
    expect(checkSiteValue("OPERATOR_ADDRESS", "a\u0000b")).toHaveProperty("error");
    expect(checkSiteValue("OPERATOR_NAME", "x".repeat(121))).toHaveProperty("error");
  });

  it("checks donation links and retention periods, and writes them compact", () => {
    expect(checkSiteValue("SUPPORT_LINKS", '[ {"label":"A","url":"https://a.example"} ]')).toEqual({
      value: '[{"label":"A","url":"https://a.example"}]',
    });
    expect(checkSiteValue("SUPPORT_LINKS", "[]")).toEqual({ value: "[]" });
    expect(checkSiteValue("SUPPORT_LINKS", '[{"label":"","url":"https://a.example"}]')).toHaveProperty("error");
    expect(checkSiteValue("SUPPORT_LINKS", '[{"label":"A","url":"data:x"}]')).toHaveProperty("error");
    expect(checkSiteValue("RETENTION", '{ "packetsHours": 6 }')).toEqual({ value: '{"packetsHours":6}' });
    expect(checkSiteValue("RETENTION", '{"packetsHours":"6"}')).toHaveProperty("error");
    expect(checkSiteValue("RETENTION", "[6]")).toHaveProperty("error");
    expect(Object.keys(RETENTION_FIELDS)).toContain("mheardDays");
  });

  it("takes an enum value only from its set", () => {
    expect(checkSiteValue("MIN_TRUST", "A")).toEqual({ value: "A" });
    expect(checkSiteValue("MIN_TRUST", "a")).toHaveProperty("error");
    expect(checkSiteValue("UPDATE_CHECK", "0")).toEqual({ value: "0" });
  });
});
