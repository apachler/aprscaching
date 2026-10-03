// SPDX-License-Identifier: AGPL-3.0-or-later
// A stage's audio clip goes up as the gateway routes it: a PUT of the raw sound to the stage's media path.
import "fake-indexeddb/auto";
import { afterEach, describe, it, expect, vi } from "vitest";
import { uploadStageClip } from "../src/api.js";

afterEach(() => vi.unstubAllGlobals());

describe("uploading a stage clip", () => {
  it("PUTs the sound to the stage's media path, with its type and the owner's call", async () => {
    const seen: { url: string; init?: RequestInit }[] = [];
    vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
      seen.push({ url: String(url), init });
      return Promise.resolve(new Response(JSON.stringify({ ok: true, mediaKey: "k" }), { status: 200 }));
    });
    const file = new File([new Uint8Array([1, 2, 3])], "clue.ogg", { type: "audio/ogg" });
    await uploadStageClip(42, 2, "OE8APR", file);
    const req = seen.find((s) => s.url.endsWith("/api/caches/42/stages/2/media"));
    expect(req?.init?.method).toBe("PUT");
    expect(new Headers(req?.init?.headers).get("content-type")).toBe("audio/ogg");
    expect(new Headers(req?.init?.headers).get("x-owner-call")).toBe("OE8APR");
  });
});
