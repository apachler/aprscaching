// SPDX-License-Identifier: AGPL-3.0-or-later
// A ham lends their own receiver to an instance they do not run: the box enrolls with a code, and the sysop
// switches on "Trust this station's hearings". These drive the real gateway over a migrated SQLite with the
// ingest box's own signing code: only a sysop switches trust, a box enrolled for a callsign is trusted only for
// sites of that call, a trusted site's direct hearing lifts another player's find to Tier A but never its own
// operator's, revoking the box ends its trust, and the sysop sees the finds the station verified. A station that is
// not an enrolled box (the sysop's own box on the shared secret) is trusted by its call the same way, beside the
// read-only presets of FIRST_PARTY_SITES.
import { describe, it, expect } from "vitest";
import { createPrivateKey } from "node:crypto";
import type { Env } from "@aprscaching/gateway/env";
import { authEnv, call, emailSignup, operatorVerify, ORIGIN } from "./helpers/authflow.js";
import { serve } from "./helpers/fedpeer.js";
import { enrollBody, newBoxKey, signedHeaders, type BoxKey } from "../../../apps/ingest/src/gatewayauth.js";

const OPS = { "x-operator-secret": "test-operator-secret" };
const INGEST = { "x-ingest-secret": "test-ingest-secret" };
const room = { fetch: async () => new Response(null, { status: 204 }) };
const ROOMS = { get: () => room };
const LENDER = "OE3LND";
const SITE = "OE3LND-10";
// the position every test packet carries: !4704.41N/01526.27E>
const LAT = 47 + 4.41 / 60;
const LON = 15 + 26.27 / 60;
const now = () => Math.floor(Date.now() / 1000);

function boxKey(box: string): BoxKey {
  const { boxKey: pkcs8, publicKey } = newBoxKey();
  return {
    box,
    key: createPrivateKey({ key: Buffer.from(pkcs8, "base64url"), format: "der", type: "pkcs8" }),
    publicKey,
  };
}

async function world() {
  // the instance's own site is OE8APR-10; the lent receiver is not listed anywhere in the env
  const env = authEnv({ ROOMS, ADMIN_CALLSIGNS: "OE8APR", FIRST_PARTY_SITES: "OE8APR-10" });
  const sysop = await emailSignup(env, "sysop@example.test", "OE8APR");
  await operatorVerify(env, "OE8APR");
  const k = boxKey("lent-1");
  const code = await call(env, "POST", "/api/admin/boxes/codes", { label: "lent", callsign: LENDER }, OPS);
  expect((await call(env, "POST", "/ingest/enroll", enrollBody(k, code.data.code))).status).toBe(201);
  return { env, sysop: { cookie: sysop.cookie! }, k };
}

const trust = (env: Env, body: unknown, headers: Record<string, string>, box = "lent-1") =>
  call(env, "POST", `/api/admin/boxes/${box}/trust`, body, headers);

/** The box hears `src` on its own TNC and posts it, signed with its key. */
async function heard(env: Env, k: BoxKey, src: string) {
  const body = JSON.stringify({
    packets: [
      {
        src,
        dst: "APRS",
        path: [],
        payload: "!4704.41N/01526.27E>",
        kind: "position",
        heardVia: "rf",
        port: "kiss-tnc",
        ts: now() - 60,
        igateCall: SITE,
      },
    ],
  });
  const url = `${ORIGIN}/ingest`;
  const res = await serve(env)(
    new Request(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...signedHeaders(k, "POST", url, body) },
      body,
    }),
  );
  expect(res.status).toBe(200);
}

let seq = 0;
/** A cache at the heard spot, and `logger`'s found log on it (as the ingest plane, so no session is needed). */
async function find(env: Env, logger: string) {
  const code = `AC-LR${++seq}`;
  const r = await env.DB.prepare(
    "INSERT INTO caches (code, owner_call, title, type, lat, lon, created_at, updated_at) VALUES (?, 'OE8OWN', 'Lent', 'traditional', ?, ?, ?, ?)",
  )
    .bind(code, LAT, LON, now() - 86400, now() - 86400)
    .run();
  const res = await call(
    env,
    "POST",
    `/api/caches/${Number(r.meta.last_row_id)}/logs`,
    { loggerCall: logger, logType: "found" },
    INGEST,
  );
  expect(res.status, JSON.stringify(res.data)).toBeLessThan(300);
  return { code, tier: res.data.tier as string };
}

const sites = async (env: Env) => (await call(env, "GET", "/ingest/check", undefined, INGEST)).data.sites as string[];
/** The sites the lent box's own frames may claim, as its signed /ingest/check reports them. */
async function boxSites(env: Env, k: BoxKey): Promise<string[]> {
  const url = `${ORIGIN}/ingest/check`;
  const res = await serve(env)(new Request(url, { headers: signedHeaders(k, "GET", url) }));
  return ((await res.json()) as { sites: string[] }).sites.sort();
}

describe("trust this station's hearings", () => {
  it("only a sysop switches it, and it starts off", async () => {
    const { env, sysop, k } = await world();
    const player = await emailSignup(env, "player@example.test", "DL1FND");
    expect((await trust(env, { trusted: true, sites: [SITE] }, {})).status).toBe(403);
    expect((await trust(env, { trusted: true, sites: [SITE] }, { cookie: player.cookie! })).status).toBe(403);
    expect((await trust(env, { trusted: true, sites: [SITE] }, INGEST)).status).toBe(403);
    expect(
      (await call(env, "GET", "/api/admin/boxes/lent-1/finds", undefined, { cookie: player.cookie! })).status,
    ).toBe(403);
    const before = await call(env, "GET", "/api/admin/boxes", undefined, { cookie: sysop.cookie });
    expect(before.data.boxes[0].trust).toBeNull();
    expect(await sites(env)).toEqual(["OE8APR-10"]);

    const on = await trust(env, { trusted: true, sites: [SITE.toLowerCase()] }, { cookie: sysop.cookie });
    expect(on.status).toBe(200);
    expect(on.data.trust).toMatchObject({ sites: [SITE], trustedByCall: "OE8APR" });
    expect(on.data.trust.trustedAt).toBeGreaterThan(0);
    // the box's site is claimed by the box's own frames, never by the shared secret's
    expect(await boxSites(env, k)).toEqual(["OE3LND-10"]);
    expect(await sites(env)).toEqual(["OE8APR-10"]);
    const listed = await call(env, "GET", "/api/admin/boxes", undefined, { cookie: sysop.cookie });
    expect(listed.data.boxes[0].trust).toMatchObject({ sites: [SITE], trustedByCall: "OE8APR" });

    const off = await trust(env, { trusted: false }, { cookie: sysop.cookie });
    expect(off.data.trust).toBeNull();
    expect(await boxSites(env, k)).toEqual([]);
  });

  it("a box enrolled for a callsign is trusted only for sites of that base call", async () => {
    const { env, sysop } = await world();
    const foreign = await trust(env, { trusted: true, sites: ["OE8APR-10"] }, { cookie: sysop.cookie });
    expect(foreign.status).toBe(403);
    const mixed = await trust(env, { trusted: true, sites: [SITE, "OE1ABC"] }, { cookie: sysop.cookie });
    expect(mixed.status).toBe(403);
    expect((await trust(env, { trusted: true, sites: ["not a call"] }, { cookie: sysop.cookie })).status).toBe(400);
    expect((await trust(env, { trusted: true, sites: [] }, { cookie: sysop.cookie })).status).toBe(400);
    expect((await trust(env, { trusted: true, sites: ["OE3LND-12", SITE] }, OPS)).status).toBe(200);
    expect((await trust(env, { trusted: true, sites: [SITE] }, OPS, "no-such-box")).status).toBe(404);
  });

  it("lifts another player's find to Tier A, never its own operator's", async () => {
    const { env, sysop, k } = await world();
    // untrusted: the box's hearing counts for nothing
    await heard(env, k, "DL1FND");
    expect((await find(env, "DL1FND")).tier).not.toBe("A");

    await trust(env, { trusted: true, sites: [SITE] }, { cookie: sysop.cookie });
    await heard(env, k, "DL2FND");
    expect((await find(env, "DL2FND")).tier).toBe("A");
    // the lender's own station never verifies the lender's own find
    await heard(env, k, "OE3LND-7");
    expect((await find(env, "OE3LND-7")).tier).not.toBe("A");
  });

  it("revoking the box ends its trust", async () => {
    const { env, sysop, k } = await world();
    await trust(env, { trusted: true, sites: [SITE] }, { cookie: sysop.cookie });
    await heard(env, k, "DL3FND");
    expect((await call(env, "POST", "/api/admin/boxes/lent-1/revoke", {}, { cookie: sysop.cookie })).status).toBe(200);
    expect(await sites(env)).toEqual(["OE8APR-10"]);
    expect((await find(env, "DL3FND")).tier).not.toBe("A");
    // a revoked box cannot be trusted, and coming back with a fresh code brings no trust along
    expect((await trust(env, { trusted: true, sites: [SITE] }, { cookie: sysop.cookie })).status).toBe(404);
    const code = await call(env, "POST", "/api/admin/boxes/codes", { callsign: LENDER }, OPS);
    expect((await call(env, "POST", "/ingest/enroll", enrollBody(boxKey("lent-1"), code.data.code))).status).toBe(201);
    const listed = await call(env, "GET", "/api/admin/boxes", undefined, OPS);
    expect(listed.data.boxes[0].trust).toBeNull();
  });

  it("shows the sysop the finds the station verified", async () => {
    const { env, sysop, k } = await world();
    const empty = await call(env, "GET", "/api/admin/boxes/lent-1/finds", undefined, { cookie: sysop.cookie });
    expect(empty.data).toMatchObject({ trust: null, count: 0, recent: [] });

    await trust(env, { trusted: true, sites: [SITE] }, { cookie: sysop.cookie });
    await heard(env, k, "DL4FND");
    const a = await find(env, "DL4FND");
    await heard(env, k, "DL5FND");
    const b = await find(env, "DL5FND");
    // a find this station did not verify is not listed
    await find(env, "DL6FND");

    const r = await call(env, "GET", "/api/admin/boxes/lent-1/finds", undefined, { cookie: sysop.cookie });
    expect(r.status).toBe(200);
    expect(r.data.trust).toMatchObject({ sites: [SITE], trustedByCall: "OE8APR" });
    expect(r.data.count).toBe(2);
    expect(r.data.recent.map((f: { code: string }) => f.code).sort()).toEqual([a.code, b.code].sort());
    expect(r.data.recent[0]).toMatchObject({ site: SITE });
    expect(r.data.recent.map((f: { loggerCall: string }) => f.loggerCall).sort()).toEqual(["DL4FND", "DL5FND"]);
  });
});

describe("trusted receiving stations", () => {
  const STATION = "OE8SHK-10";
  /** The sysop's own box on the shared secret hears `src` directly at STATION. */
  const heardViaSecret = async (env: Env, src: string) => {
    const packet = {
      src,
      dst: "APRS",
      path: [],
      payload: "!4704.41N/01526.27E>",
      kind: "position",
      heardVia: "rf",
      port: "kiss-tnc",
      ts: now() - 60,
      igateCall: STATION,
    };
    expect((await call(env, "POST", "/ingest", { packets: [packet] }, INGEST)).status).toBe(200);
  };

  it("only a sysop lists, adds and removes them", async () => {
    const { env } = await world();
    const player = await emailSignup(env, "player@example.test", "DL1FND");
    const as = { cookie: player.cookie! };
    expect((await call(env, "GET", "/api/admin/sites", undefined, as)).status).toBe(403);
    expect((await call(env, "POST", "/api/admin/sites", { site: STATION }, as)).status).toBe(403);
    expect((await call(env, "POST", "/api/admin/sites", { site: STATION }, INGEST)).status).toBe(403);
    expect((await call(env, "POST", "/api/admin/sites", { site: STATION }, OPS)).status).toBe(201);
    expect((await call(env, "DELETE", `/api/admin/sites/${STATION}`, undefined, as)).status).toBe(403);
    expect((await call(env, "GET", `/api/admin/sites/${STATION}/finds`, undefined, as)).status).toBe(403);
  });

  it("shows configuration presets read-only beside the stations added here and the trusted boxes", async () => {
    const { env, sysop } = await world();
    const as = { cookie: sysop.cookie };
    expect((await call(env, "POST", "/api/admin/sites", { site: "OE8APR-10" }, as)).status).toBe(409);
    expect((await call(env, "DELETE", "/api/admin/sites/OE8APR-10", undefined, as)).status).toBe(404);
    expect((await call(env, "POST", "/api/admin/sites", { site: "not a call" }, as)).status).toBe(400);
    await call(env, "POST", "/api/admin/sites", { site: STATION.toLowerCase() }, as);
    await trust(env, { trusted: true, sites: [SITE] }, as);
    const list = (await call(env, "GET", "/api/admin/sites", undefined, as)).data.sites;
    expect(list).toEqual([
      expect.objectContaining({ site: "OE8APR-10", source: "config", trustedAt: null }),
      expect.objectContaining({ site: SITE, source: "box", box: "lent-1", trustedByCall: "OE8APR" }),
      expect.objectContaining({ site: STATION, source: "admin", trustedByCall: "OE8APR" }),
    ]);
    // a box's site is managed under its box, not removed here
    expect((await call(env, "DELETE", `/api/admin/sites/${SITE}`, undefined, as)).status).toBe(404);
  });

  it("lifts a find to Tier A while trusted, lists what it verified, and stops when removed", async () => {
    const { env, sysop } = await world();
    const as = { cookie: sysop.cookie };
    await heardViaSecret(env, "DL1FND");
    expect((await find(env, "DL1FND")).tier).not.toBe("A");

    await call(env, "POST", "/api/admin/sites", { site: STATION }, as);
    expect(await sites(env)).toContain(STATION);
    await heardViaSecret(env, "DL2FND");
    const a = await find(env, "DL2FND");
    expect(a.tier).toBe("A");
    // the station's own operator is never verified by it
    await heardViaSecret(env, "OE8SHK-7");
    expect((await find(env, "OE8SHK-7")).tier).not.toBe("A");

    const finds = await call(env, "GET", `/api/admin/sites/${STATION}/finds`, undefined, as);
    expect(finds.data).toMatchObject({ site: STATION, count: 1, recent: [{ code: a.code, loggerCall: "DL2FND" }] });

    expect((await call(env, "DELETE", `/api/admin/sites/${STATION}`, undefined, as)).status).toBe(200);
    expect(await sites(env)).toEqual(["OE8APR-10"]);
    await heardViaSecret(env, "DL3FND");
    expect((await find(env, "DL3FND")).tier).not.toBe("A");
  });
});
