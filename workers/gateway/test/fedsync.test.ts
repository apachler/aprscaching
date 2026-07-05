// SPDX-License-Identifier: AGPL-3.0-or-later
// The CBOR sync surface end-to-end in miniature: serve a page of signed fedwire frames from a mock
// DB, then consume it the way federation_sync does — decode the page, verify each frame under the
// instance key, and map the wire body back to the JSON record shape. Also pins the scaled-field
// codec: fractional fields travel as integer twins and restore to the same values.
import { describe, it, expect, beforeAll } from "vitest";
import { handleFedSync, decodeFedSyncPage, encodeFedSyncPage, bodyToWire, bodyFromWire } from "../src/fedsync.js";
import { verifyFedFrame } from "../src/fedcbor.js";
import type { Env } from "../src/env.js";

const b64 = (buf: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const b64url = (buf: ArrayBuffer) => b64(buf).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

let publicX: string;
let keyEnvVal: string;

beforeAll(async () => {
  const kp = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  publicX = b64url(await crypto.subtle.exportKey("raw", kp.publicKey));
  keyEnvVal = btoa(JSON.stringify({ pkcs8: b64(await crypto.subtle.exportKey("pkcs8", kp.privateKey)), pub: publicX }));
});

describe("scaled-field body codec", () => {
  it("round-trips fractional fields through integer twins, preserving nulls and other fields", () => {
    const data = {
      code: "ACS-1",
      lat: 47.0832156,
      lon: null,
      difficulty: 1.5,
      terrain: 3,
      distanceM: 12.34,
      verified: true,
    };
    const wire = bodyToWire(data);
    expect(wire).toMatchObject({ latE7: 470832156, difficultyX10: 15, terrainX10: 30, distanceCm: 1234 });
    expect(wire).not.toHaveProperty("lat");
    expect(wire.lon).toBeNull(); // null is not a number — passes through untouched
    expect(bodyFromWire(wire)).toEqual({ ...data, distanceM: 12.34 });
  });

  it("rounds sub-resolution distances (centimetre wire resolution)", () => {
    expect(bodyFromWire(bodyToWire({ distanceM: 2.4991 })).distanceM).toBe(2.5);
  });
});

describe("CBOR sync page codec", () => {
  it("round-trips and rejects malformed envelopes", () => {
    const frames = [new Uint8Array([1, 2, 3]), new Uint8Array([4])];
    const page = decodeFedSyncPage(encodeFedSyncPage("oe.pub", 42, false, frames));
    expect(page).toEqual({ instance: "oe.pub", nextCursor: 42, complete: false, frames });
    expect(() => decodeFedSyncPage(new Uint8Array([0x80]))).toThrow(/not a map/);
  });
});

describe("serve + consume a cache page", () => {
  const cacheRow = {
    id: 42,
    code: "ACS-042",
    owner_call: "OE8APR",
    title: "Schlossberg",
    type: "traditional",
    status: "active",
    difficulty: 1.5,
    terrain: 2,
    lat: 47.0832,
    lon: 15.4232,
    station_call: null,
    source: "native",
    external_id: null,
    hint: "spoiler — must not federate",
    description: "at the top",
    min_trust: null,
    fed_scope: "public",
    created_at: 1000,
    updated_at: 2000,
  };
  const db = {
    prepare: (sql: string) => ({
      bind: () => ({
        async all() {
          return { results: sql.includes("FROM caches") ? [cacheRow] : [] };
        },
        async first() {
          return null;
        },
        async run() {
          return {};
        },
      }),
    }),
  };

  it("serves signed frames that verify under the instance key and restore the JSON record shape", async () => {
    const env = { DB: db, FED_PRIVATE_KEY: keyEnvVal, INSTANCE: "oe.pub" } as unknown as Env;
    const res = await handleFedSync(new Request("http://gw/federation/sync/cache?since=0"), env, "cache");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/cbor");

    const page = decodeFedSyncPage(new Uint8Array(await res.arrayBuffer()));
    expect(page.instance).toBe("oe.pub");
    expect(page.nextCursor).toBe(2000); // the row's updated_at high-water mark
    expect(page.frames).toHaveLength(1);

    const frame = await verifyFedFrame(page.frames[0]!, [publicX]);
    expect(frame).not.toBeNull();
    expect(frame!.record).toMatchObject({ kind: "cache", gid: "oe.pub:cache:42", origin: "oe.pub", v: 2000 });
    const data = bodyFromWire(frame!.record.body);
    expect(data).toMatchObject({ code: "ACS-042", lat: 47.0832, lon: 15.4232, difficulty: 1.5, terrain: 2 });
    expect(data).not.toHaveProperty("hint"); // the spoiler redaction holds on the CBOR surface too
  });

  it("404s unknown feed types (forward-compat contract shared with the JSON feeds)", async () => {
    const env = { DB: db, FED_PRIVATE_KEY: keyEnvVal, INSTANCE: "oe.pub" } as unknown as Env;
    const res = await handleFedSync(new Request("http://gw/federation/sync/nope"), env, "nope");
    expect(res.status).toBe(404);
  });
});
