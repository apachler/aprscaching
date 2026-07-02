// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it, expect } from "vitest";
import { buildTxPayload } from "../src/tx.js";
import { thirdPartyEncap } from "@aprsweb/aprs";

describe("gated user TX payload (docs/design/19 P3)", () => {
  it("builds a message info field", () => {
    const r = buildTxPayload({ kind: "message", addressee: "OE1XYZ", text: "hi there" });
    expect(r.ok && r.kind).toBe("message");
    expect(r.ok && r.payload).toBe(":OE1XYZ   :hi there");
  });

  it("builds a position beacon info field", () => {
    const r = buildTxPayload({ kind: "beacon", lat: 47.07, lon: 15.44, symbol: "/>", comment: "mobile" });
    expect(r.ok && r.kind).toBe("beacon");
    expect(r.ok && r.payload.startsWith("!")).toBe(true);
    expect(r.ok && r.payload).toContain("mobile");
  });

  it("rejects a bad request", () => {
    expect(buildTxPayload({ kind: "message", addressee: "", text: "x" }).ok).toBe(false);
    expect(buildTxPayload({ kind: "beacon", lat: 200, lon: 0 }).ok).toBe(false);
    expect(buildTxPayload({ kind: "nope" }).ok).toBe(false);
  });

  it("the enqueued payload wraps correctly as third-party when the box drains it", () => {
    const r = buildTxPayload({ kind: "message", addressee: "OE1XYZ", text: "ping" });
    // the ingest box (validate-at-deploy) encapsulates the outbox row under the peer's login:
    const line = r.ok ? thirdPartyEncap({ gateCall: "OE8APR-10", userCall: "OE3ABC-7", info: r.payload }) : "";
    expect(line).toBe("OE8APR-10>APRS,TCPIP*:}OE3ABC-7>APZACG,TCPIP*::OE1XYZ   :ping");
  });
});
