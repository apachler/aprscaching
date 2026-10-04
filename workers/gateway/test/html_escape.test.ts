// SPDX-License-Identifier: AGPL-3.0-or-later
// Every server-rendered page, SVG and XML document escapes interpolated data through one helper that
// covers both text and quoted-attribute contexts, so a value can never close an attribute or open a tag.
import { describe, it, expect } from "vitest";
import { escapeHtml, stripTags } from "../src/util/html.js";
import { trimEndChars } from "../src/util/text.js";
import { handleImprintPage, handlePrivacyPage } from "../src/legal.js";
import { handleSupportPage } from "../src/support.js";
import { handleBadge } from "../src/badge.js";
import { sanitizeBio, sanitizeDisplayName } from "../src/profile.js";
import { appBase } from "../src/sitemap.js";
import { sourceInfo } from "../src/source.js";
import type { Env } from "../src/env.js";

const PAYLOADS = [`"><script>alert(1)</script>`, `' onmouseover='alert(1)`, `" onmouseover="alert(1)`];

/** A database stand-in that answers every query with no rows. */
const emptyDb = {
  prepare: () => ({
    bind() {
      return this;
    },
    first: async () => null,
    all: async () => ({ results: [] }),
    run: async () => ({}),
  }),
};

/** No payload survives with a raw quote or angle bracket. */
function expectInert(html: string): void {
  for (const p of PAYLOADS) expect(html).not.toContain(p);
  expect(html).not.toContain("<script>alert");
  expect(html).not.toMatch(/["'] onmouseover=/);
}

describe("escapeHtml", () => {
  it("escapes & < > \" and '", () => {
    expect(escapeHtml(`&<>"'`)).toBe("&amp;&lt;&gt;&quot;&#39;");
    expect(escapeHtml(`"><script>`)).toBe("&quot;&gt;&lt;script&gt;");
    expect(escapeHtml(`' onmouseover=`)).toBe("&#39; onmouseover=");
  });

  it("leaves plain text and non-ASCII untouched and escapes '&' only once", () => {
    expect(escapeHtml("OE8APR · Klagenfurt")).toBe("OE8APR · Klagenfurt");
    expect(escapeHtml("&amp;")).toBe("&amp;amp;");
  });
});

describe("stripTags", () => {
  it("removes complete tags", () => {
    expect(stripTags("<b>hi</b> there")).toBe("hi there");
    expect(stripTags("a<scr<script>ipt>b")).toBe("aipt>b");
  });

  it("never leaves a '<' that could open a tag", () => {
    for (const s of ["<script", "x<script src=y", "<<script", "a</b", "<!--", "<?php", "<<<a"])
      expect(stripTags(s)).not.toMatch(/<[A-Za-z/!?]/);
  });

  it("keeps a '<' that cannot open a tag", () => {
    expect(stripTags("I <3 radio")).toBe("I <3 radio");
    expect(stripTags("a < b")).toBe("a < b");
  });

  it("is linear on a long run of '<'", () => {
    const t0 = performance.now();
    expect(stripTags("<".repeat(200_000) + "a")).toBe("a");
    expect(performance.now() - t0).toBeLessThan(1000);
  });
});

describe("profile sanitizers keep markup out", () => {
  it("bio and display name never carry a tag opener", () => {
    for (const s of ["<script>alert(1)</script>", "<scr<script>ipt>", "hi <img src=x onerror=alert(1)", "<<script"]) {
      expect(sanitizeBio(s) ?? "").not.toMatch(/<[A-Za-z/!?]/);
      expect(sanitizeDisplayName(s) ?? "").not.toMatch(/[<>]/);
    }
    expect(sanitizeDisplayName("  <b>Max</b>  ")).toBe("Max");
  });
});

describe("legal pages escape operator values in attributes", () => {
  for (const evil of PAYLOADS) {
    it(`imprint and privacy stay inert for ${JSON.stringify(evil)}`, async () => {
      const env = {
        INSTANCE: evil,
        OPERATOR_NAME: evil,
        OPERATOR_ADDRESS: evil,
        OPERATOR_EMAIL: `a${evil}@b.example`,
      } as unknown as Env;
      expectInert(await handleImprintPage(env).text());
      expectInert(await handlePrivacyPage(env).text());
    });
  }
});

describe("support page escapes configured links", () => {
  it("a link URL or label cannot break out of its attribute", async () => {
    const links = PAYLOADS.map((p, i) => ({ label: p, url: `https://pay.example/${i}${p}` }));
    const env = { DB: emptyDb, SUPPORT_LINKS: JSON.stringify(links) } as unknown as Env;
    const html = await (await handleSupportPage(new Request("https://gw.example/support"), env)).text();
    expect(html).toContain('href="https://pay.example/0&quot;&gt;&lt;script&gt;');
    expectInert(html);
  });
});

describe("badge SVG escapes its text and attributes", () => {
  it("callsign and instance cannot break out", async () => {
    const env = { DB: emptyDb, INSTANCE: PAYLOADS[1] } as unknown as Env;
    const svg = await (await handleBadge(new Request("https://gw.example/badge/x.svg"), env, PAYLOADS[0]!)).text();
    expectInert(svg);
    expect(svg).toContain("&quot;&gt;&lt;SCRIPT&gt;");
  });
});

describe("trailing-slash trimming is linear", () => {
  it("strips only the trailing run", () => {
    expect(trimEndChars("https://a.example///", "/")).toBe("https://a.example");
    expect(trimEndChars("///", "/")).toBe("");
    expect(trimEndChars("abc", "/")).toBe("abc");
  });

  it("a long run of '/' followed by text is handled fast", () => {
    const long = "https://a.example" + "/".repeat(200_000) + "x";
    const t0 = performance.now();
    expect(appBase({ APP_URL: long } as unknown as Env)).toBe(long);
    expect(sourceInfo({ SOURCE_REPO: long } as unknown as Env).repo).toBe(long);
    expect(performance.now() - t0).toBeLessThan(1000);
  });
});
