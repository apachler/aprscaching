// SPDX-License-Identifier: AGPL-3.0-or-later
// A signed browser batch authenticates ONE operator. On a PUBLIC gateway (no shared ingest secret)
// it may carry only that operator's own traffic — otherwise any registered device key would let an
// attacker inject positions/stations/messages attributed to arbitrary callsigns at Tier C. Relaying
// third-party RF is the trusted path's job (self-host ingest secret / apps/ingest). This test drives
// handleIngest with a real Ed25519-signed batch and asserts foreign-src frames are dropped.
import { describe, it, expect } from "vitest";
import { handleIngest } from "../src/ingest.js";
import type { Env } from "../src/env.js";
import { ingestMessage, sha256Hex, stableStringify } from "@aprsweb/shared";

const b64u = (buf: ArrayBuffer) => {
  let s = "";
  for (const b of new Uint8Array(buf)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

/** Minimal mock DB: records every batched statement's SQL + binds; answers the few reads ingest does. */
function mockDb(captured: { sql: string; binds: unknown[] }[]) {
  const make = (sql: string) => {
    const stmt = {
      sql,
      binds: [] as unknown[],
      bind(...args: unknown[]) {
        this.binds = args;
        return this;
      },
      async run() {
        return { success: true };
      },
      async first() {
        if (sql.includes("FROM callsign_keys")) return { x: 1 }; // isKeyRegistered → yes
        if (sql.includes("rate_limits")) return { count: 1 }; // under the limit
        return null;
      },
      async all() {
        return { results: [] as unknown[] };
      },
    };
    return stmt;
  };
  return {
    prepare: (sql: string) => make(sql),
    async batch(stmts: { sql: string; binds: unknown[] }[]) {
      for (const s of stmts) captured.push({ sql: s.sql, binds: s.binds });
      return [];
    },
  };
}

const rooms = {
  idFromName: (n: string) => n,
  get: () => ({ fetch: async () => new Response("ok") }),
};

async function signedIngest(env: Env, signerCall: string, packets: unknown[]) {
  const kp = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const pub = b64u(await crypto.subtle.exportKey("raw", kp.publicKey));
  const at = Math.floor(Date.now() / 1000);
  const digest = await sha256Hex(stableStringify(packets));
  const sig = b64u(
    await crypto.subtle.sign(
      "Ed25519",
      kp.privateKey,
      new TextEncoder().encode(ingestMessage({ callsign: signerCall, at, count: packets.length, digest })),
    ),
  );
  const req = new Request("http://gw/ingest", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-acs-callsign": signerCall,
      "x-acs-key": pub,
      "x-acs-sig": sig,
      "x-acs-at": String(at),
    },
    body: JSON.stringify({ packets }),
  });
  return handleIngest(req, env, {} as never);
}

// Fully-defaulted packet: the browser signs the exact object the gateway digests after zod parsing,
// so every field the schema would otherwise default (kind/heardVia/port/path) is set here.
const posn = (src: string) => ({
  src,
  dst: "APZACG",
  path: ["WIDE1-1"],
  kind: "position",
  payload: "=4712.00N/01503.00E>test",
  heardVia: "rf",
  port: "browser-rf",
  ts: Math.floor(Date.now() / 1000),
});

/** Which callsigns got a `positions` row from this batch. */
function positionCallsigns(captured: { sql: string; binds: unknown[] }[]): string[] {
  return captured.filter((s) => s.sql.startsWith("INSERT INTO positions")).map((s) => String(s.binds[0]));
}

describe("signed ingest binds every stored frame to the authenticated signer", () => {
  it("stores the signer's own frame (any SSID of their base call)", async () => {
    const captured: { sql: string; binds: unknown[] }[] = [];
    const env = { DB: mockDb(captured), ROOMS: rooms, INGEST_SECRET: "unused" } as unknown as Env;
    const res = await signedIngest(env, "OE8APR", [posn("OE8APR-9")]);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, stored: 1 });
    expect(positionCallsigns(captured)).toEqual(["OE8APR-9"]);
  });

  it("drops a frame the signer relays for a DIFFERENT callsign — no spoofed position/station", async () => {
    const captured: { sql: string; binds: unknown[] }[] = [];
    const env = { DB: mockDb(captured), ROOMS: rooms, INGEST_SECRET: "unused" } as unknown as Env;
    const res = await signedIngest(env, "OE8APR", [posn("OE8APR-9"), posn("DL9XYZ-1")]);
    expect(res.status).toBe(200);
    // only the signer's own frame is stored; the relayed foreign frame is refused
    expect(await res.json()).toMatchObject({ stored: 1 });
    const calls = positionCallsigns(captured);
    expect(calls).toContain("OE8APR-9");
    expect(calls).not.toContain("DL9XYZ-1");
    // no packets_recent / stations / messages row for the foreign call either
    expect(captured.some((s) => s.binds.some((b) => b === "DL9XYZ-1"))).toBe(false);
  });
});
