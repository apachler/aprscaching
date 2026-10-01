// SPDX-License-Identifier: AGPL-3.0-or-later
// A find queued offline reaches the gateway hours after it was made. Its device-key signature carries the
// time it was made, and within bounds that is the find time: the find is scored, stored and federated at
// that moment, so it gets the verification it would have had if sent at once. Outside the bounds the find
// time is the receive time and the log keeps the reason.
import { describe, it, expect } from "vitest";
import { authorshipMessage } from "@aprscaching/shared";
import { FIND_FEED } from "@aprscaching/gateway/federation";
import { instanceEnv, serve } from "./helpers/fedpeer.js";
import type { Env } from "@aprscaching/gateway/env";

const INSTANCE = "field.example";
const LOGGER = "OE8LOG";
const SITE = "OE8XXX";
const LAT = 47.0707;
const LON = 15.4395;
const H = 3600;
const DAY = 24 * H;
const now = () => Math.floor(Date.now() / 1000);
const b64u = (b: ArrayBuffer) => Buffer.from(b).toString("base64url");

let seq = 0;
async function setup(opts: { cacheAge?: number; keyAge?: number } = {}) {
  const env = instanceEnv(INSTANCE, null, { FIRST_PARTY_SITES: SITE }) as unknown as Env;
  const kp = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const pub = b64u(await crypto.subtle.exportKey("raw", kp.publicKey));
  await env.DB.prepare("INSERT INTO callsign_keys (callsign, public_key, created_at) VALUES (?, ?, ?)")
    .bind(LOGGER, pub, now() - (opts.keyAge ?? 30 * DAY))
    .run();
  const code = `AC-FT${++seq}`;
  const created = now() - (opts.cacheAge ?? 30 * DAY);
  const r = await env.DB.prepare(
    "INSERT INTO caches (code, owner_call, title, type, lat, lon, created_at, updated_at) VALUES (?, 'OE8OWN', 'Field', 'traditional', ?, ?, ?, ?)",
  )
    .bind(code, LAT, LON, created, created)
    .run();
  return { env, kp, pub, code, id: Number(r.meta.last_row_id) };
}
type Setup = Awaited<ReturnType<typeof setup>>;

/** The attested site's own TNC heard the logger at the cache at `ts`. */
const heard = (env: Env, ts: number) =>
  env.DB.prepare(
    "INSERT INTO positions (callsign, ts, lat, lon, heard_via, igate_call, path, source, transport) VALUES (?, ?, ?, ?, 'rf', ?, 'WIDE1-1', 'aprs', 'tnc')",
  )
    .bind(LOGGER, ts, LAT, LON, SITE)
    .run();

/** POST a found log as the ingest plane; `at` signs it, `extra` adds body fields. */
async function log(s: Setup, at: number | null, extra: Record<string, unknown> = {}) {
  const body: Record<string, unknown> = { loggerCall: LOGGER, logType: "found", ...extra };
  if (at != null) {
    const msg = authorshipMessage({ cache: s.code, instance: INSTANCE, logger: LOGGER, logType: "found", at });
    const sig = b64u(await crypto.subtle.sign("Ed25519", s.kp.privateKey, new TextEncoder().encode(msg)));
    body.author = { authorKey: s.pub, authorSig: sig, signedAt: at };
  }
  const res = await serve(s.env)(
    new Request(`https://${INSTANCE}/api/caches/${s.id}/logs`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-ingest-secret": "test-ingest-secret" },
      body: JSON.stringify(body),
    }),
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}
const row = (s: Setup) =>
  s.env.DB.prepare("SELECT * FROM cache_logs WHERE cache_id = ? AND logger_call = ?")
    .bind(s.id, LOGGER)
    .first<{ ts: number; received_at: number; field_time_rejected: string | null; tier: string | null }>();

describe("a signed field time", () => {
  it("verifies a find synced 8 hours late at the tier it would have had at once", async () => {
    const live = await setup();
    await heard(live.env, now() - 600);
    const atOnce = await log(live, now());

    const late = await setup();
    const at = now() - 8 * H;
    await heard(late.env, at - 600);
    const synced = await log(late, at);

    expect(atOnce.body.tier).toBe("A");
    expect(synced.body.tier).toBe(atOnce.body.tier);
    expect(synced.body.foundAt).toBe(at);
    const r = await row(late);
    expect(r?.ts).toBe(at);
    expect(r?.field_time_rejected).toBeNull();
    expect(r!.received_at - now()).toBeLessThanOrEqual(1);
  });

  it("judges the phone's GPS fix against the field time", async () => {
    const s = await setup();
    const at = now() - 8 * H;
    const res = await log(s, at, { appGeo: { lat: LAT, lon: LON, accuracyM: 10, ts: at } });
    expect(res.body.tier).toBe("B");
    expect(res.body.method).toBe("app_geo");
  });

  it("federates the find at its field time", async () => {
    const s = await setup();
    const at = now() - 5 * H;
    await log(s, at);
    const rows = await FIND_FEED.selectRows(s.env, 0, 10);
    expect(FIND_FEED.recordOf(rows[0]!, INSTANCE).data).toMatchObject({ ts: at, signedAt: at });
  });

  it("stays idempotent per cache and logger", async () => {
    const s = await setup();
    const at = now() - 2 * H;
    await log(s, at);
    const again = await log(s, at);
    expect(again.body.duplicate).toBe(true);
    const n = await s.env.DB.prepare("SELECT COUNT(*) AS n FROM cache_logs WHERE cache_id = ?")
      .bind(s.id)
      .first<{ n: number }>();
    expect(n?.n).toBe(1);
  });
});

describe("outside the bounds the find time is the receive time", () => {
  const cases: [string, Parameters<typeof setup>[0], (t: number) => number][] = [
    ["future", {}, (t) => t + 2 * H],
    ["too_old", {}, (t) => t - 8 * DAY],
    ["before_cache", { cacheAge: H }, (t) => t - 2 * H],
    ["before_key", { keyAge: H }, (t) => t - 2 * H],
  ];
  for (const [reason, opts, signed] of cases)
    it(`${reason}`, async () => {
      const s = await setup(opts);
      const at = signed(now());
      await heard(s.env, at - 600); // evidence at the claimed time, which must not count
      const res = await log(s, at);
      expect(res.status).toBe(200);
      expect(res.body.fieldTimeRejected).toBe(reason);
      expect(res.body.tier).not.toBe("A");
      const r = await row(s);
      expect(Math.abs(r!.ts - now())).toBeLessThanOrEqual(1);
      expect(r?.field_time_rejected).toBe(reason);
    });

  it("a clock a few seconds ahead is taken, never after the arrival", async () => {
    const s = await setup();
    const res = await log(s, now() + 30);
    expect(res.body.fieldTimeRejected).toBeNull();
    expect(res.body.foundAt as number).toBeLessThanOrEqual(now());
  });

  it("an unsigned log the client queued keeps the sync time and is marked unsigned", async () => {
    const queued = await setup();
    expect((await log(queued, null, { offline: true })).body.fieldTimeRejected).toBe("unsigned");
    const live = await setup();
    expect((await log(live, null)).body.fieldTimeRejected).toBeNull();
  });
});
