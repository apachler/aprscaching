// SPDX-License-Identifier: AGPL-3.0-or-later
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { onDemandList, precacheList } from "../vite-sw.js";
import { forgetSession, recallSession, rememberSession, type SessionStore } from "../src/identity/sessionMemory.js";

describe("the precache list", () => {
  it("takes every built file and the public files the app references, never the excluded ones", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "acs-sw-"));
    const put = (f: string, body = "") => {
      fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
      fs.writeFileSync(path.join(dir, f), body);
    };
    put(
      "index.html",
      '<link href="/manifest.webmanifest"><link href="/icons/favicon.ico"><link href="/icons/splash/a.png"><script src="/assets/app-1.js">',
    );
    put("assets/app-1.js", 'img("/brand/logo.png")');
    put("assets/app-1.js.map");
    put("assets/app-1.css", "src:url(/fonts/a.woff2)");
    put("manifest.webmanifest", '{"icons":[{"src":"/icons/m-192.png"}]}');
    for (const f of [
      "icons/favicon.ico",
      "icons/splash/a.png",
      "icons/m-192.png",
      "icons/unused.png",
      "brand/logo.png",
    ])
      put(f);
    put("fonts/a.woff2");
    put("vendor/maplibre.js", "/brand/logo.png");
    put("sw.js");
    expect(precacheList(dir, ["index.html", "assets/app-1.js", "assets/app-1.js.map", "assets/app-1.css"])).toEqual([
      "/assets/app-1.css",
      "/assets/app-1.js",
      "/brand/logo.png",
      "/fonts/a.woff2",
      "/icons/favicon.ico",
      "/icons/m-192.png",
      "/index.html",
      "/manifest.webmanifest",
    ]);
  });
});

describe("the on-demand files", () => {
  it("leaves the WebAssembly out of the precache list and stores it on demand", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "acs-sw-"));
    fs.mkdirSync(path.join(dir, "assets"));
    for (const f of ["index.html", "assets/modem-1.wasm"]) fs.writeFileSync(path.join(dir, f), "");
    // the code that fetches it names it, which must not pull it into the precache list
    fs.writeFileSync(path.join(dir, "assets/app-1.js"), 'fetch("/assets/modem-1.wasm")');
    const emitted = ["index.html", "assets/app-1.js", "assets/modem-1.wasm"];
    expect(precacheList(dir, emitted)).toEqual(["/assets/app-1.js", "/index.html"]);
    expect(onDemandList(emitted)).toEqual(["/assets/modem-1.wasm"]);
  });
});

describe("the remembered session", () => {
  const mem = (): SessionStore => {
    const m = new Map<string, string>();
    return { get: (k) => m.get(k) ?? null, set: (k, v) => void m.set(k, v), remove: (k) => void m.delete(k) };
  };
  it("keeps only the callsign and whether it is verified", () => {
    const s = mem();
    rememberSession(s, { callsign: "OE8APR", verified: true, email: "x@example.org" });
    expect(recallSession(s)).toEqual({ callsign: "OE8APR", verified: true });
  });
  it("is forgotten when the server says signed out, or on sign-out", () => {
    const s = mem();
    rememberSession(s, { callsign: "OE8APR" });
    rememberSession(s, { callsign: null });
    expect(recallSession(s)).toBeNull();
    rememberSession(s, { callsign: "OE8APR" });
    forgetSession(s);
    expect(recallSession(s)).toBeNull();
  });
  it("reads damaged storage as nothing remembered", () => {
    const s = mem();
    s.set("acs.session", "{oops");
    expect(recallSession(s)).toBeNull();
  });
});
