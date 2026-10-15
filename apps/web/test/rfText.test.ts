// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { KissDecoder, encodeAx25, kissWrap } from "@aprscaching/aprs";
import { decodeKissFrames } from "../src/rf/kiss.js";

/** Text as sent on the air in UTF-8, held one character per byte. */
const utf8 = (text: string) => String.fromCharCode(...new TextEncoder().encode(text));

describe("a frame the browser hears", () => {
  it("shows UTF-8 text as UTF-8 and keeps the bytes for the gateway", () => {
    const payload = utf8(":OE5XYZ   :Grüße{7");
    const kiss = kissWrap(encodeAx25({ src: "OE8ABC-7", dst: "APRS", payload }));
    const [f] = decodeKissFrames(new KissDecoder().push(kiss), 1_700_000_000_000);
    expect(f?.data).toMatchObject({ kind: "message", text: "Grüße" });
    expect(f?.frame.payload).toBe(payload);
    expect(f?.packet.payload).toBe(payload);
  });
});
