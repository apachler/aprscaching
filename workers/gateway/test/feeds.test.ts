// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it, expect } from "vitest";
import { handleBulletinsFeed } from "../src/feeds.js";
import { xmlEscape } from "../src/sitemap.js";
import type { Env } from "../src/env.js";

/** The code points XML 1.0 forbids anywhere in a document, escaped or not. */
const XML_ILLEGAL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/;

function bulletinEnv(row: Record<string, unknown>): Env {
  return {
    APP_URL: "https://app.example",
    DB: {
      prepare: () => ({ bind: () => ({ all: async () => ({ results: [row] }) }) }),
    },
  } as unknown as Env;
}

describe("XML feeds", () => {
  it("xmlEscape drops the control characters XML cannot carry and keeps tab, newline and return", () => {
    expect(xmlEscape("a\u0007b\u001Ac\u0000d\uFFFE")).toBe("abcd");
    expect(xmlEscape("a\tb\nc\rd & <e>")).toBe("a\tb\nc\rd &amp; &lt;e&gt;");
  });

  it("a bulletin carrying control characters keeps the bulletin feed well-formed", async () => {
    const env = bulletinEnv({
      id: 1,
      fromCall: "OE8APR",
      toCall: "ALL",
      subject: "x\u0000",
      body: "hello\u0007world\u001A",
      postedAt: 1_700_000_000,
    });
    const text = await (await handleBulletinsFeed(new Request("https://app.example/feeds/bulletins.xml"), env)).text();
    expect(text).toContain("<description>helloworld</description>");
    expect(text).not.toMatch(XML_ILLEGAL);
  });
});
