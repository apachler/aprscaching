// SPDX-License-Identifier: AGPL-3.0-or-later
// The trust reads judge evidence in the database (track.ts), so the database's answer must be the verify engine's:
// the SQL form of attestation decides every stored row as provenanceOf does, and the database's speed test refuses
// exactly the presences the engine refuses.
import { describe, it, expect } from "vitest";
import { Worker } from "node:worker_threads";
import { createRequire } from "node:module";
import { attestedSql, provenanceOf } from "@aprscaching/gateway/provenance";
import { sitesFor, type Attestation } from "@aprscaching/gateway/attestedsites";
import { outrunBy } from "@aprscaching/gateway/track";
import { plausiblePresence, type PositionRow } from "@aprscaching/gateway/verify";
import type { Env } from "@aprscaching/gateway/env";
import { authEnv } from "./helpers/authflow.js";

const SITE = "OE8XXX-10";
const BOX_SITE = "OE8BOX-10";
const A: Attestation = { shared: new Set([SITE]), byBox: new Map([["box-1", new Set([BOX_SITE])]]) };

describe("the SQL form of attestation", () => {
  it("decides every stored row as provenanceOf does", async () => {
    const env = authEnv();
    const rows: unknown[][] = [];
    for (const via of ["rf", "aprs_is"])
      for (const transport of ["tnc", "meshcom", "aprs-is", "axudp", "browser-rf", "nonsense"])
        for (const igate of [null, "", SITE, SITE.toLowerCase(), BOX_SITE, "OE8OTH-10"])
          for (const box of [null, "", "box-1", "box-2"])
            for (const path of [
              null,
              "",
              "WIDE1-1",
              "WIDE1-1,qAR,X",
              "WIDE1-1,qAO,X",
              "qAC,qAR",
              "qAR,qAC",
              " qAO ,X",
              "\tqAC\t,qAR",
              "q AR,qAC",
              "qar,qAX",
              "WIDE2-1,,qAR",
            ])
              rows.push([via, transport, igate, box, path]);
    for (let i = 0; i < rows.length; i += 500) {
      const part = rows.slice(i, i + 500);
      await env.DB.prepare(
        `INSERT INTO positions (callsign, ts, lat, lon, heard_via, transport, igate_call, ingest_box, path)
         VALUES ${part.map(() => "('OE8LOG-9', 1, 47, 15, ?, ?, ?, ?, ?)").join(",")}`,
      )
        .bind(...part.flat())
        .run();
    }
    const att = attestedSql(A, "p");
    const got = (
      await env.DB.prepare(`SELECT p.*, ${att.sql} AS sql_attested FROM positions p`)
        .bind(...att.binds)
        .all<PositionRow & { sql_attested: number; path: string | null; transport: string }>()
    ).results;
    expect(got.length).toBe(rows.length);
    const differ = got.filter(
      (p) => !!p.sql_attested !== provenanceOf(p, sitesFor(A, p.ingest_box)).firstPartyAttested,
    );
    expect(differ).toEqual([]);
    // both answers occur, so the comparison saw each side
    expect(new Set(got.map((p) => !!p.sql_attested))).toEqual(new Set([true, false]));
  });

  it("trims a path token and upper-cases a site call as provenanceOf does, beyond ASCII", async () => {
    const env = authEnv();
    const site = "OE8XXI-10";
    const att = { shared: new Set([site]), byBox: new Map<string, Set<string>>() };
    // every character JavaScript's trim strips, read from the runtime rather than listed, with neighbours it keeps
    const blank: string[] = [];
    for (let c = 0; c <= 0xffff; c++) {
      if (c >= 0xd800 && c <= 0xdfff) continue;
      if (String.fromCharCode(c).trim() === "") blank.push(String.fromCharCode(c));
    }
    expect(blank.length).toBeGreaterThan(20);
    const kept = ["\u0085", "\u180e", "\u200b", "\u2060", "x"];
    const paths = [...blank, ...kept].flatMap((c) => [`${c}qAS,X`, `qAS${c},X`, `${c}qAR${c}`, `W${c},qAC`]);
    const igates = [site, "oe8xxi-10", "oe8xx\u0131-10", "OE8XX\u0130-10", "\u00f6e8xxi-10"];
    const rows = paths.flatMap((path) => igates.map((igate) => [igate, path]));
    for (let i = 0; i < rows.length; i += 400) {
      const part = rows.slice(i, i + 400);
      await env.DB.prepare(
        `INSERT INTO positions (callsign, ts, lat, lon, heard_via, transport, igate_call, path)
         VALUES ${part.map(() => "('OE8LOG-9', 1, 47, 15, 'rf', 'tnc', ?, ?)").join(",")}`,
      )
        .bind(...part.flat())
        .run();
    }
    const sql = attestedSql(att, "p");
    const got = (
      await env.DB.prepare(`SELECT p.*, ${sql.sql} AS sql_attested FROM positions p`)
        .bind(...sql.binds)
        .all<PositionRow & { sql_attested: number; path: string | null }>()
    ).results;
    expect(got.length).toBe(rows.length);
    const differ = got
      .filter((p) => !!p.sql_attested !== provenanceOf(p, sitesFor(att, p.ingest_box)).firstPartyAttested)
      .map((p) => ({ igate: p.igate_call, path: JSON.stringify(p.path), sql: !!p.sql_attested }));
    expect(differ).toEqual([]);
    expect(new Set(got.map((p) => !!p.sql_attested))).toEqual(new Set([true, false]));
  });
});

/**
 * Runs `sql` over `paths` in a worker thread on its own in-memory SQLite, so a query that never ends is cut off
 * after `ms` and fails the test instead of blocking the suite (the driver's calls are synchronous). Answers, per path
 * in order, the SQL attestation (0 or 1), or null when the query did not end.
 */
async function inWorker(sql: string, binds: string[], igate: string, paths: string[], ms = 10_000) {
  const code = `
    const { parentPort, workerData: w } = require("node:worker_threads");
    const Database = require(w.driver);
    const db = new Database(":memory:");
    db.exec("CREATE TABLE positions (id INTEGER PRIMARY KEY, heard_via TEXT, transport TEXT, igate_call TEXT, ingest_box TEXT, path TEXT)");
    const ins = db.prepare("INSERT INTO positions (heard_via, transport, igate_call, path) VALUES ('rf', 'tnc', ?, ?)");
    for (const p of w.paths) ins.run(w.igate, p);
    const rows = db.prepare("SELECT p.id, " + w.sql + " AS a FROM positions p ORDER BY p.id").all(...w.binds);
    parentPort.postMessage(rows.map((r) => r.a));
  `;
  const driver = createRequire(import.meta.url).resolve("better-sqlite3");
  const worker = new Worker(code, { eval: true, workerData: { sql, binds, igate, paths, driver } });
  try {
    return await new Promise<number[] | null>((resolve, reject) => {
      const timer = setTimeout(() => resolve(null), ms);
      worker.once("message", (m: number[]) => {
        clearTimeout(timer);
        resolve(m);
      });
      worker.once("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
    });
  } finally {
    await worker.terminate();
  }
}

describe("the SQL path split", () => {
  it("ends for any stored path, a NUL anywhere in it included", async () => {
    const att = attestedSql(A, "p");
    const shapes = [
      "X,qAS#",
      "#",
      "#,",
      ",#",
      "qAR#,X",
      "a#b,qAC",
      "##,#",
      "WIDE1-1,qAR,X#",
      "X,qAS#Y,Z",
      "#qAR",
      "qAC,#",
    ];
    const paths = shapes.map((x) => x.replaceAll("#", "\u0000"));
    const got = await inWorker(att.sql, att.binds, SITE, paths);
    expect(got, "the query did not end within 10 s").not.toBeNull();
    expect(got).toHaveLength(paths.length);
  }, 20_000);
});

/** The point `m` metres from (lat, lon) on initial bearing `brg` degrees (spherical, R as haversineMeters). */
function destination(lat: number, lon: number, brg: number, m: number): { lat: number; lon: number } {
  const R = 6371000,
    d = m / R,
    t = (brg * Math.PI) / 180,
    p1 = (lat * Math.PI) / 180,
    l1 = (lon * Math.PI) / 180;
  const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(t));
  const l2 = l1 + Math.atan2(Math.sin(t) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
  return { lat: (p2 * 180) / Math.PI, lon: (((l2 * 180) / Math.PI + 540) % 360) - 180 };
}

describe("the database's speed test", () => {
  it("refuses exactly the presences the engine refuses, anywhere on the globe and near the limit", async () => {
    const env: Env = authEnv();
    const maxMps = (300 * 1000) / 3600;
    // a fixed, spread sequence of cases: positions over every latitude and across the antimeridian, gaps up to the
    // window, distances from well inside to well outside what the speed allows
    let seed = 7;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    let refused = 0;
    const n = 400;
    for (let i = 0; i < n; i++) {
      const lat = -89.5 + 179 * rnd();
      const lon = -180 + 360 * rnd();
      const dt = Math.floor(1800 * rnd());
      const slack = i % 3 === 0 ? 300 : 0;
      const factor = i % 5 === 0 ? 0.5 + 5 * rnd() : 0.97 + 0.06 * rnd();
      const far = destination(lat, lon, 360 * rnd(), maxMps * Math.max(1, dt + slack) * factor);
      const call = `T${i}A`;
      const r = await env.DB.prepare(
        `INSERT INTO positions (callsign, ts, lat, lon, heard_via, transport, source, path)
         VALUES (?, 1000, ?, ?, 'rf', 'browser-rf', 'browser-rf', 'WIDE1-1')`,
      )
        .bind(call, lat, lon)
        .run();
      const at = { lat: far.lat, lon: far.lon, ts: 1000 + dt };
      const sql = await outrunBy(env, call, 0, 5000, A, at, { maxMps, slackSec: slack });
      const row = (await env.DB.prepare("SELECT * FROM positions WHERE id = ?")
        .bind(Number(r.meta.last_row_id))
        .first<PositionRow>())!;
      const engine = !plausiblePresence(
        at,
        [{ ...row, commanded: false, firstPartyAttested: false }],
        undefined,
        slack,
      );
      expect({ i, refused: !!sql }).toEqual({ i, refused: engine });
      if (engine) refused++;
    }
    // both answers occur, so the comparison saw each side
    expect(refused).toBeGreaterThan(n / 10);
    expect(refused).toBeLessThan(n - n / 10);
  });
});
