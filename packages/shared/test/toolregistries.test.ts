// SPDX-License-Identifier: MIT
// How a tool-registry address is written and checked: the github: shorthand, https URLs, and TOOL_REGISTRIES.
import { describe, it, expect } from "vitest";
import {
  BUILTIN_TOOL_REGISTRY,
  defaultRegistryLabel,
  expandGithubShorthand,
  isAuthorityKey,
  parseToolRegistriesEnv,
  registryLabel,
  registrySourceUrl,
} from "../src/index.js";

const RAW = "https://raw.githubusercontent.com";

describe("the github: shorthand", () => {
  it("expands owner/repo to the default branch's registry.json", () => {
    expect(expandGithubShorthand("github:apachler/aprscaching-tools")).toEqual({
      url: `${RAW}/apachler/aprscaching-tools/HEAD/registry.json`,
    });
  });
  it("takes a path to a file or a folder, and a ref", () => {
    expect(expandGithubShorthand("github:club/tools/dist/reg.json@v1.2.0")).toEqual({
      url: `${RAW}/club/tools/v1.2.0/dist/reg.json`,
    });
    expect(expandGithubShorthand("github:club/tools/dist@main")).toEqual({
      url: `${RAW}/club/tools/main/dist/registry.json`,
    });
    expect(expandGithubShorthand("github:club/tools/dist/")).toEqual({
      url: `${RAW}/club/tools/HEAD/dist/registry.json`,
    });
    expect(expandGithubShorthand("github:club/tools@release/2026")).toEqual({
      url: `${RAW}/club/tools/release/2026/registry.json`,
    });
  });
  it("refuses a missing repo, dot segments and odd characters", () => {
    for (const bad of [
      "github:club",
      "github:/tools",
      "github:club/tools/../x.json",
      "github:club/tools@..",
      "github:club/tools/a b",
      "github:club/tools/%2e%2e/x.json",
      "github:-club/tools",
      "github:club/tools//x.json",
    ])
      expect(expandGithubShorthand(bad), bad).toHaveProperty("error");
  });
});

describe("registrySourceUrl", () => {
  it("accepts https URLs and GitHub Pages, and drops the fragment", () => {
    expect(registrySourceUrl(" https://club.github.io/tools/registry.json#x ")).toEqual({
      spec: "https://club.github.io/tools/registry.json#x",
      url: "https://club.github.io/tools/registry.json",
    });
    expect(registrySourceUrl("GitHub:club/tools")).toEqual({
      spec: "github:club/tools",
      url: `${RAW}/club/tools/HEAD/registry.json`,
    });
  });
  it("refuses http, credentials, relative paths, overlong input and blanks", () => {
    for (const bad of [
      "http://club.example/registry.json",
      "https://user:pw@club.example/registry.json",
      "https://user@club.example/registry.json",
      "/tools/registry.json",
      "ftp://club.example/r.json",
      `https://club.example/${"a".repeat(500)}`,
      "",
      "   ",
      42,
      "https://club.example/a b",
    ])
      expect(registrySourceUrl(bad), String(bad)).toHaveProperty("error");
  });
});

describe("authority keys and labels", () => {
  it("knows a 32-byte base64url key", () => {
    expect(isAuthorityKey(BUILTIN_TOOL_REGISTRY.authority)).toBe(true);
    expect(isAuthorityKey("uibFUCjcBnxAe8mRQ1v2neJd0fPV_7Vs0Y59K5vH5Oc")).toBe(true);
    expect(isAuthorityKey("uibFUCjcBnxAe8mRQ1v2neJd0fPV_7Vs0Y59K5vH5Od")).toBe(false); // spare bits set
    expect(isAuthorityKey("short")).toBe(false);
    expect(isAuthorityKey(null)).toBe(false);
  });
  it("labels a registry by its repo or host", () => {
    expect(defaultRegistryLabel(`${RAW}/club/tools/HEAD/registry.json`)).toBe("club/tools");
    expect(defaultRegistryLabel("https://club.example/r.json")).toBe("club.example");
    expect(registryLabel("  Club\ntools ", "x")).toBe("Club tools");
    expect(registryLabel("", "fallback")).toBe("fallback");
    expect(registryLabel("y".repeat(99), "x")).toHaveLength(60);
  });
});

describe("TOOL_REGISTRIES", () => {
  it("reads builtin, URLs, shorthand and instance paths", () => {
    const r = parseToolRegistriesEnv(
      JSON.stringify([
        "builtin",
        { url: "github:club/tools@v1", authority: BUILTIN_TOOL_REGISTRY.authority, label: "Club" },
        { url: "/club/registry.json", authority: BUILTIN_TOOL_REGISTRY.authority, enabled: false },
      ]),
    );
    expect("entries" in r).toBe(true);
    if (!("entries" in r)) return;
    expect(r.entries.map((e) => [e.id, e.url, e.label, e.enabled])).toEqual([
      ["builtin", "/tools/registry.json", "APRScaching tools", true],
      ["env-2", `${RAW}/club/tools/v1/registry.json`, "Club", true],
      ["env-3", "/club/registry.json", "/club/registry.json", false],
    ]);
  });
  it("names the item that is wrong", () => {
    expect(parseToolRegistriesEnv("{")).toEqual({ error: "TOOL_REGISTRIES is not JSON" });
    expect(parseToolRegistriesEnv("{}")).toHaveProperty("error");
    expect(parseToolRegistriesEnv(JSON.stringify([{ url: "https://a.example/r.json" }]))).toEqual({
      error: "TOOL_REGISTRIES item 1: authority must be a base64url Ed25519 public key",
    });
    expect(
      parseToolRegistriesEnv(JSON.stringify(["builtin", { url: "http://a.example", authority: "x" }])),
    ).toMatchObject({ error: expect.stringMatching(/^TOOL_REGISTRIES item 2: .*https/) });
  });
});
