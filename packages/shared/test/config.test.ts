// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { CONFIG_KEYS, keysOf, shapesOf, validateConfig, type ConfigKey, type ConfigKeyName } from "../src/config.js";
import { CONFIG_HINTS } from "../src/configdocs.js";

const names = Object.keys(CONFIG_KEYS) as ConfigKeyName[];

describe("the configuration schema", () => {
  it("gives every enum its values and every key a unit", () => {
    for (const n of names) {
      const k: ConfigKey = CONFIG_KEYS[n];
      expect(k.units.length, n).toBeGreaterThan(0);
      if (k.type === "enum") expect(k.values?.length, n).toBeGreaterThan(0);
    }
  });

  it("keeps each literal default valid for its own type", () => {
    const src = Object.fromEntries(names.map((n) => [n, (CONFIG_KEYS[n] as ConfigKey).default]));
    expect(
      validateConfig(src, ["gateway", "server", "desktop", "ingest", "web", "deploy", "pocket", "licence"]),
    ).toEqual([]);
  });

  it("has a one-line hint for every key", () => {
    for (const n of names) expect(CONFIG_HINTS[n], n).toMatch(/^[^\n\t]{3,100}$/);
  });

  it("lists the secrets the gateway and the ingest box hold", () => {
    for (const n of [
      "INGEST_SECRET",
      "OPERATOR_SECRET",
      "SESSION_SECRET",
      "FED_PRIVATE_KEY",
      "APRSIS_PASSCODE",
    ] as const)
      expect(CONFIG_KEYS[n].secret, n).toBe(true);
  });

  it("selects the keys of a unit and the shapes of a key", () => {
    expect(keysOf("gateway")).toContain("APP_URL");
    expect(keysOf("gateway")).not.toContain("KISS_TNC_HOST");
    expect(keysOf("ingest")).toContain("KISS_TNC_HOST");
    expect(shapesOf("KISS_TNC_HOST")).toContain("ingest-box");
    expect(shapesOf("KISS_TNC_HOST")).not.toContain("cloudflare");
    expect(shapesOf("APP_URL")).toContain("cloudflare");
    expect(shapesOf("TRUST_CF")).not.toContain("cloudflare");
  });
});

describe("validateConfig", () => {
  it("checks callsigns: AX.25 roles take SSID 0-15, a site list a MeshCom SSID too", () => {
    const keys = (src: Record<string, string>) => validateConfig(src, ["gateway", "ingest"]).map((p) => p.key);
    expect(
      keys({ DIGI_CALL: "OE8APR-10", FIRST_PARTY_SITES: "OE8APR-10, OE8APR-42", ADMIN_CALLSIGNS: "OE8APR" }),
    ).toEqual([]);
    expect(keys({ DIGI_CALL: "OE8APR-20" })).toEqual(["DIGI_CALL"]);
    expect(keys({ SERVICE_CALL: "APRSCG" })).toEqual(["SERVICE_CALL"]);
    expect(keys({ BBS_NODE_CALL: "OE8APRXY-8" })).toEqual(["BBS_NODE_CALL"]);
    expect(keys({ FIRST_PARTY_SITES: "OE8APR-10,nope" })).toEqual(["FIRST_PARTY_SITES"]);
  });

  it("accepts unset and blank values", () => {
    expect(validateConfig({}, "gateway")).toEqual([]);
    expect(validateConfig({ SESSION_TTL_DAYS: "", TRUST_PROXY: "  " }, "gateway")).toEqual([]);
  });

  it("refuses a malformed value, naming the key and never the value", () => {
    const problems = validateConfig(
      { SESSION_TTL_DAYS: "thirty", TRUST_PROXY: "true", FED_KEY_HISTORY: "[{", APP_URL: "aprs.example.net" },
      "gateway",
    );
    expect(problems.map((p) => p.key).sort()).toEqual([
      "APP_URL",
      "FED_KEY_HISTORY",
      "SESSION_TTL_DAYS",
      "TRUST_PROXY",
    ]);
    for (const p of problems) {
      expect(p.message.startsWith(`${p.key}: `)).toBe(true);
      expect(p.message).not.toMatch(/thirty|aprs\.example\.net|\[\{/);
    }
    expect(problems.find((p) => p.key === "TRUST_PROXY")?.message).toContain("expected one of: 0, 1");
  });

  it("accepts well-formed values", () => {
    expect(
      validateConfig(
        { SESSION_TTL_DAYS: "7", TRUST_PROXY: "1", FED_KEY_HISTORY: "[]", APP_URL: "https://aprs.example.net" },
        "gateway",
      ),
    ).toEqual([]);
    expect(
      validateConfig(
        { APRSIS_PASSCODE: "-1", MESHCOM_RATE: "2.5", INGEST_URL: "http://gateway:8080/ingest" },
        "ingest",
      ),
    ).toEqual([]);
  });

  it("checks only the keys of the units asked for", () => {
    expect(validateConfig({ KISS_TNC_PORT: "x" }, "gateway")).toEqual([]);
    expect(validateConfig({ KISS_TNC_PORT: "x" }, "ingest")).toHaveLength(1);
    // a key two units read is reported once
    expect(validateConfig({ OPERATOR_SECRET: "s", TRUST_CF: "yes" }, ["gateway", "server"])).toHaveLength(1);
  });
});
