// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it, expect } from "vitest";
import { buildTxPayload, handleUserTx } from "../src/tx.js";
import { issueSessionCookie } from "../src/auth.js";
import type { Env } from "../src/env.js";
import { thirdPartyEncap } from "@aprsweb/aprs";

describe("gated user TX payload", () => {
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

// handleUserTx layers the control-verification GATE over buildTxPayload: TX is off unless the caller
// is signed in AND their callsign is control-verified. Neither a session alone nor an APRS-IS passcode
// authorizes injection (transport ≠ authorization) — the wire source must be a real, verified call.
describe("handleUserTx — control-verification gate", () => {
  const SECRET = "strong-ingest-secret-xyz";
  // Mock DB: answers the callsign_verifications lookup + captures the aprs_outbox insert binds.
  const txDb = (status: string | null, sink: { rows: unknown[][] }) => ({
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async first() {
              return sql.includes("callsign_verifications") ? (status ? { status } : null) : null;
            },
            async run() {
              if (sql.startsWith("INSERT INTO aprs_outbox")) sink.rows.push(args);
              return { meta: { last_row_id: 42 } };
            },
          };
        },
      };
    },
  });
  const post = async (callsign: string | null, body: unknown, env: Env) => {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (callsign) headers.cookie = (await issueSessionCookie(callsign, env)).split(";")[0]!;
    return new Request("http://gw/api/tx", { method: "POST", headers, body: JSON.stringify(body) });
  };

  it("401 when signed out", async () => {
    const env = { INGEST_SECRET: SECRET, DB: txDb(null, { rows: [] }) } as unknown as Env;
    const res = await handleUserTx(await post(null, { kind: "beacon", lat: 47, lon: 15 }, env), env);
    expect(res.status).toBe(401);
  });

  it("403 when signed in but the callsign is NOT control-verified", async () => {
    const env = { INGEST_SECRET: SECRET, DB: txDb("pending", { rows: [] }) } as unknown as Env;
    const res = await handleUserTx(await post("OE8APR", { kind: "beacon", lat: 47, lon: 15 }, env), env);
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/control-verification required/);
  });

  it("201 and enqueues under the verified call when control-verified", async () => {
    const sink = { rows: [] as unknown[][] };
    const env = { INGEST_SECRET: SECRET, DB: txDb("verified", sink) } as unknown as Env;
    const res = await handleUserTx(await post("OE8APR", { kind: "beacon", lat: 47.07, lon: 15.42 }, env), env);
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ srcCall: "OE8APR", kind: "beacon", status: "queued" });
    expect(sink.rows[0]![1]).toBe("OE8APR"); // src_call is the verified callsign
  });
});
