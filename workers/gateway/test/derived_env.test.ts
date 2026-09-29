// SPDX-License-Identifier: AGPL-3.0-or-later
// INSTANCE and RP_ID default to APP_URL's hostname, so an operator configures one public URL instead of
// three strings that must agree. An explicit value always wins; a blank one (compose passes `${VAR:-}`)
// counts as unset.
import { describe, it, expect } from "vitest";
import { applyDerivedDefaults, type Env } from "../src/env.js";
import { handle } from "../src/app.js";
import type { ExecCtx } from "../src/runtime.js";

const env = (over: Record<string, unknown>) => ({ DB: {}, INGEST_SECRET: "x", ...over }) as unknown as Env;

describe("applyDerivedDefaults", () => {
  it("derives INSTANCE and RP_ID from APP_URL's hostname", () => {
    const e = applyDerivedDefaults(env({ APP_URL: "https://oe.example.net" }));
    expect(e.INSTANCE).toBe("oe.example.net");
    expect(e.RP_ID).toBe("oe.example.net");
  });

  it("drops the port and path of APP_URL", () => {
    const e = applyDerivedDefaults(env({ APP_URL: "http://192.168.1.10:8080/app/" }));
    expect(e.INSTANCE).toBe("192.168.1.10");
    expect(e.RP_ID).toBe("192.168.1.10");
  });

  it("keeps explicit values", () => {
    const e = applyDerivedDefaults(
      env({ APP_URL: "https://app.example.net", INSTANCE: "oe.net", RP_ID: "example.net" }),
    );
    expect(e.INSTANCE).toBe("oe.net");
    expect(e.RP_ID).toBe("example.net");
  });

  it("treats a blank value as unset", () => {
    const e = applyDerivedDefaults(env({ APP_URL: "https://oe.example.net", INSTANCE: "", RP_ID: "  " }));
    expect(e.INSTANCE).toBe("oe.example.net");
    expect(e.RP_ID).toBe("oe.example.net");
  });

  it("leaves both unset without a usable APP_URL", () => {
    expect(applyDerivedDefaults(env({})).INSTANCE).toBeUndefined();
    const bad = applyDerivedDefaults(env({ APP_URL: "not a url" }));
    expect(bad.INSTANCE).toBeUndefined();
    expect(bad.RP_ID).toBeUndefined();
  });

  it("reaches every route through handle()", async () => {
    const e = env({
      APP_URL: "https://oe.example.net",
      DB: { prepare: () => ({ first: async () => ({ ok: 1 }) }) },
    });
    const res = await handle(new Request("http://127.0.0.1:8080/health"), e, {
      waitUntil: () => {},
    } as unknown as ExecCtx);
    expect(((await res.json()) as { instance: string }).instance).toBe("oe.example.net");
  });
});
