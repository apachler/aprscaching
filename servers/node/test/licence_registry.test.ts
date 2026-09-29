// SPDX-License-Identifier: AGPL-3.0-or-later
// Callsign validity from public licence registers. The operator's import tool reads a register file,
// keeps only callsign, status and expiry, and posts batches to the gateway with the ingest secret; the
// gateway answers `GET /api/licence/:call` and shows the result beside a held call. The check only
// flags: a call no register lists is "unconfirmed", never refused, and it is kept apart from
// control-verification.
//
// Every register fixture below is SYNTHETIC: invented callsigns and people, laid out in each source's
// verified file format.
import { describe, it, expect, beforeAll } from "vitest";
import zlib from "node:zlib";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Env } from "@aprscaching/gateway/env";
import { authEnv, call, emailSignup } from "./helpers/authflow.js";
import { serve } from "./helpers/fedpeer.js";

const TOOLS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../tools/licence");
const SECRET = { "x-ingest-secret": "test-ingest-secret" };
const DAY = 86400;
const nowS = () => Math.floor(Date.now() / 1000);

// The import tool is plain ESM JavaScript; load it by a computed path.
const load = (rel: string): Promise<any> => import(pathToFileURL(path.join(TOOLS, rel)).href);
let lib: any;
let sources: any;
beforeAll(async () => {
  lib = await load("lib.mjs");
  sources = (await load("sources/index.mjs")).SOURCES;
});

/** A zip archive (deflate) holding the given text files — enough of the format for the reader. */
function makeZip(files: Record<string, string>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const data = Buffer.from(text, "latin1");
    const comp = zlib.deflateRawSync(data);
    const crc = zlib.crc32(data);
    const nameB = Buffer.from(name);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(8, 8);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(comp.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nameB.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(8, 10);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(comp.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(nameB.length, 28);
    ch.writeUInt32LE(offset, 42);
    locals.push(lh, nameB, comp);
    centrals.push(ch, nameB);
    offset += lh.length + nameB.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

const tmpFile = (name: string, body: Buffer | string) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "licence-"));
  const f = path.join(dir, name);
  fs.writeFileSync(f, body);
  return f;
};

/** Collect a source's parsed rows from a local file. */
async function parsed(id: string, file: string) {
  const out: Array<{ callsign: string; status: string; expiresAt: number | null }> = [];
  for await (const r of lib.readSource(sources[id], file)) out.push(r);
  return out;
}

/** Run the import tool against `env` in-process (its fetch is routed to the gateway). */
function runImport(env: Env, id: string, file: string, extra: Record<string, unknown> = {}) {
  return lib.importSource({
    source: sources[id],
    file,
    base: "https://gw.test",
    secret: "test-ingest-secret",
    fetch: (url: string, init: RequestInit) => serve(env)(new Request(url, init)),
    log: () => {},
    ...extra,
  });
}

// ---- synthetic FCC ULS (l_amat.zip): pipe-delimited HD records, call sign in field 5, status in 6,
// radio service in 7, grant/expiry/cancel dates (MM/DD/YYYY) in 8/9/10; names further along ----
const hd = (id: number, call: string, status: string, exp: string, svc = "HA") =>
  `HD|${id}|||${call}|${status}|${svc}|01/01/2016|${exp}||||||||||N||||||||||N||Testfirst|Q|Testlast||||||||||01/01/2016|01/01/2016|||||||||||||||`;
const FCC_ZIP = () =>
  makeZip({
    "HD.dat": [
      hd(1, "K0TST", "A", "03/15/2034"),
      hd(2, "W0OLD", "E", "02/01/2020"),
      hd(3, "N0DUP", "C", "05/05/2015"),
      hd(4, "N0DUP", "A", "05/05/2033"), // a later active grant of the same call wins
      hd(5, "KD0LAP", "A", "01/10/2021"), // still "A" in the file, but past its expiry
      hd(6, "AB0TT", "T", "06/06/2030"),
    ].join("\r\n"),
    "EN.dat":
      "EN|1|||K0TST|L|L00000001|Testlast, Testfirst Q|Testfirst|Q|Testlast|||||1 Synthetic Rd|Nowhere|ZZ|00000|||000|0000000001|I||||||\r\n",
    counts: "synthetic\n",
  });

// ---- synthetic ISED amateur_delim.txt: `;`-separated, callsign first, then names, address, quals ----
const ISED_ZIP = () =>
  makeZip({
    "amateur_delim.txt":
      "callsign;first_name;surname;address_line;city;prov_cd;postal_code;qual_a;qual_b;qual_c;qual_d;qual_e;club_name;club_name_2;club_address;club_city;club_prov_cd;club_postal_code\r\n" +
      "VA9TST;Testfirst;Testlast;1 Synthetic St;NOWHERE;ZZ;Z0Z0Z0;A;;;;;;;;;;\r\n" +
      "VE9CLB;;;;;;;;;;;;Synthetic Club;;1 Club Rd;NOWHERE;ZZ;Z0Z0Z0\r\n",
    "readme_amat_delim.txt": "synthetic\r\n",
  });

// ---- synthetic ACMA RRL: licence.csv (SV_ID 6 = Amateur) joined to device_details.csv CALL_SIGN ----
const ACMA_ZIP = () =>
  makeZip({
    "licence.csv":
      "LICENCE_NO,CLIENT_NO,SV_ID,SS_ID,LICENCE_TYPE_NAME,LICENCE_CATEGORY_NAME,DATE_ISSUED,DATE_OF_EFFECT,DATE_OF_EXPIRY,STATUS,STATUS_TEXT,AP_ID,AP_PRJ_IDENT,SHIP_NAME,BSL_NO,AWL_TYPE\n" +
      "900001/1,1,6,602,Amateur,Amateur Repeater,2020-01-01,2020-01-01,2035-06-01,1,Granted,1,,,,\n" +
      "900002/1,2,6,601,Amateur,Amateur Beacon,2010-01-01,2010-01-01,2019-06-01,10,Expired,2,,,,\n" +
      "900003/1,3,3,305,Land Mobile,Land Mobile System 0-30MHz,2020-01-01,2020-01-01,2035-06-01,1,Granted,3,,,,\n",
    "device_details.csv":
      "SDD_ID,LICENCE_NO,DEVICE_REGISTRATION_IDENTIFIER,CALL_SIGN,STATION_NAME\n" +
      '1,900001/1,,VK9RTS,"Synthetic Hill, Repeater"\n' +
      "2,900002/1,,VK9BTS,\n" +
      "3,900003/1,,VK9LMS,\n",
  });

// ---- synthetic text extractions (pdftotext) of the Austrian and German callsign lists ----
const AT_TEXT = [
  "Rufzeichenliste österreichischer Amateurfunkstellen",
  "Rufzeichen   Name   Standort   Anschrift   Bew_Kl",
  "OE9TST          Testlast Testfirst        9999 Nirgendwo      Teststraße 1        1",
  "OE9HID          *-*-*                     *-*-*               *-*-*               1",
  "OE9XTS          Synthetischer Verein -    9999 Nirgendwo      Testweg 2           1",
  "                Ortsgruppe Test",
  "Fernmeldebüro Stand 01.01.2026 Seite 1 von 1",
].join("\n");
const DE_TEXT = [
  "Verzeichnis der zugeteilten deutschen Amateurfunkrufzeichen",
  "Seite 3",
  "DA9TST, A, Testfirst Testlast; Teststr.",
  "1, 99999 Nirgendwo",
  "DB9TST, E, Testfirst Testlast      DL9TST, N, Testfirst Testlast",
  "DL100TEST, A, Synthetischer Verein",
].join("\n");

describe("source parsers keep only callsign, status and expiry", () => {
  it("FCC: HD records, collapsed per call; a lapsed active grant reads as expired", async () => {
    const rows = await parsed("fcc", tmpFile("l_amat.zip", FCC_ZIP()));
    const by = Object.fromEntries(rows.map((r) => [r.callsign, r]));
    expect(Object.keys(by).sort()).toEqual(["AB0TT", "K0TST", "KD0LAP", "N0DUP", "W0OLD"]);
    expect(by.K0TST).toEqual({
      callsign: "K0TST",
      status: "licensed",
      expiresAt: Date.UTC(2034, 2, 15) / 1000 + DAY - 1,
    });
    expect(by.W0OLD!.status).toBe("expired");
    expect(by.N0DUP!.status).toBe("licensed");
    expect(by.AB0TT!.status).toBe("expired");
    for (const r of rows) expect(Object.keys(r).sort()).toEqual(["callsign", "expiresAt", "status"]);
    expect(JSON.stringify(rows)).not.toMatch(/Test(first|last)|Synthetic/);
  });

  it("ISED: every listed call is licensed, with no expiry", async () => {
    const rows = await parsed("ised", tmpFile("amateur_delim.zip", ISED_ZIP()));
    expect(rows).toEqual([
      { callsign: "VA9TST", status: "licensed", expiresAt: null },
      { callsign: "VE9CLB", status: "licensed", expiresAt: null },
    ]);
  });

  it("ACMA: amateur licences only, joined to their call sign", async () => {
    const rows = await parsed("acma", tmpFile("spectra_rrl.zip", ACMA_ZIP()));
    expect(rows.sort((a, b) => a.callsign.localeCompare(b.callsign))).toEqual([
      { callsign: "VK9BTS", status: "expired", expiresAt: Date.UTC(2019, 5, 1) / 1000 + DAY - 1 },
      { callsign: "VK9RTS", status: "licensed", expiresAt: Date.UTC(2035, 5, 1) / 1000 + DAY - 1 },
    ]);
  });

  it("Austria: the call at the start of each list line, redacted entries included", async () => {
    const rows = await parsed("at", tmpFile("at.txt", AT_TEXT));
    expect(rows.map((r) => r.callsign)).toEqual(["OE9TST", "OE9HID", "OE9XTS"]);
    expect(rows.every((r) => r.status === "licensed" && r.expiresAt === null)).toBe(true);
  });

  it("Germany: every `CALL, class,` entry, including several on one extracted line", async () => {
    const rows = await parsed("de", tmpFile("de.txt", DE_TEXT));
    expect(rows.map((r) => r.callsign)).toEqual(["DA9TST", "DB9TST", "DL9TST", "DL100TEST"]);
  });
});

describe("importing into the gateway", () => {
  it("refuses an import without the ingest secret", async () => {
    const env = authEnv();
    const r = await call(env, "POST", "/api/licence/import", {
      source: "fcc",
      importedAt: nowS(),
      rows: [["K0TST", "licensed", null]],
    });
    expect(r.status).toBe(401);
  });

  it("stores exactly the registry columns and answers lookups", async () => {
    const env = authEnv();
    const res = await runImport(env, "fcc", tmpFile("l_amat.zip", FCC_ZIP()));
    expect(res.accepted).toBe(5);
    const cols = (
      await env.DB.prepare("SELECT name FROM pragma_table_info('licence_registry')").all<{ name: string }>()
    )
      .results!.map((c) => c.name)
      .sort();
    expect(cols).toEqual(["callsign", "expires_at", "source", "status", "updated_at"]);

    const ok = await call(env, "GET", "/api/licence/k0tst-9");
    expect(ok.status).toBe(200);
    expect(ok.data).toMatchObject({ callsign: "K0TST", status: "licensed", source: "fcc", sourceName: "FCC" });
    expect(ok.data.expiresAt).toBeGreaterThan(nowS());
    expect(ok.data.checkedAt).toBeGreaterThan(0);
    expect((await call(env, "GET", "/api/licence/KD0LAP")).data.status).toBe("expired");
    expect((await call(env, "GET", "/api/licence/W0OLD")).data.status).toBe("expired");
    expect((await call(env, "GET", "/api/licence/VE%2FK0TST%2FP")).data.callsign).toBe("K0TST");
    const none = await call(env, "GET", "/api/licence/OE9ZZZ");
    expect(none.status).toBe(200);
    expect(none.data).toEqual({ callsign: "OE9ZZZ", status: "unconfirmed" });
    expect((await call(env, "GET", "/api/v1/licence/K0TST")).data.status).toBe("licensed");
    expect((await call(env, "GET", "/api/licence/%2F%2F")).status).toBe(400);
  });

  it("replaces a source on re-import: calls missing from the new file are removed", async () => {
    const env = authEnv();
    await runImport(env, "fcc", tmpFile("l_amat.zip", FCC_ZIP()));
    await runImport(env, "ised", tmpFile("amateur_delim.zip", ISED_ZIP()));
    const smaller = makeZip({ "HD.dat": hd(1, "K0TST", "A", "03/15/2034") });
    const res = await runImport(env, "fcc", tmpFile("l_amat.zip", smaller), { importedAt: nowS() + 5 });
    expect(res.removed).toBe(4);
    expect((await call(env, "GET", "/api/licence/W0OLD")).data.status).toBe("unconfirmed");
    expect((await call(env, "GET", "/api/licence/K0TST")).data.status).toBe("licensed");
    // another register's rows are untouched
    expect((await call(env, "GET", "/api/licence/VA9TST")).data.source).toBe("ised");
  });

  it("prunes nothing when the finish count does not match what arrived", async () => {
    const env = authEnv();
    await runImport(env, "fcc", tmpFile("l_amat.zip", FCC_ZIP()));
    const at = nowS() + 10;
    await call(
      env,
      "POST",
      "/api/licence/import",
      { source: "fcc", importedAt: at, rows: [["K0TST", "licensed", null]] },
      SECRET,
    );
    const fin = await call(
      env,
      "POST",
      "/api/licence/import/finish",
      { source: "fcc", importedAt: at, count: 3 },
      SECRET,
    );
    expect(fin.status).toBe(409);
    expect((await call(env, "GET", "/api/licence/W0OLD")).data.status).toBe("expired");
  });

  it("refuses a batch older than the source's latest import", async () => {
    const env = authEnv();
    const at = nowS();
    const ok = await call(
      env,
      "POST",
      "/api/licence/import",
      { source: "ised", importedAt: at, rows: [["VA9TST", "licensed", null]] },
      SECRET,
    );
    expect(ok.status).toBe(200);
    const stale = await call(
      env,
      "POST",
      "/api/licence/import",
      { source: "ised", importedAt: at - 60, rows: [["VA9OLD", "licensed", null]] },
      SECRET,
    );
    expect(stale.status).toBe(409);
  });

  it("skips malformed rows and never stores anything beyond the three fields", async () => {
    const env = authEnv();
    const r = await call(
      env,
      "POST",
      "/api/licence/import",
      {
        source: "ised",
        importedAt: nowS(),
        rows: [
          ["VA9TST", "licensed", null, "Testfirst Testlast"],
          ["not a call", "licensed", null],
          ["VA9BAD", "maybe", null],
        ],
      },
      SECRET,
    );
    expect(r.data).toMatchObject({ accepted: 1, skipped: 2 });
    const row = await env.DB.prepare("SELECT * FROM licence_registry").all();
    expect(JSON.stringify(row.results)).not.toMatch(/Testfirst/);
  });

  it("lists each source with its row count and import date", async () => {
    const env = authEnv();
    await runImport(env, "ised", tmpFile("amateur_delim.zip", ISED_ZIP()));
    const r = await call(env, "GET", "/api/licence");
    expect(r.data.sources).toEqual([
      expect.objectContaining({ source: "ised", sourceName: "ISED Canada", rows: 2, importedAt: expect.any(Number) }),
    ]);
  });
});

describe("the licence badge beside a held call", () => {
  it("sign-up, adding a call and the held-call list carry a validity result, and nothing is refused", async () => {
    const env = authEnv();
    await runImport(env, "fcc", tmpFile("l_amat.zip", FCC_ZIP()));
    const me = await emailSignup(env, "k0tst@example.test", "K0TST");
    expect(me.status).toBe(200);
    expect(me.data.licence).toMatchObject({ status: "licensed", source: "fcc" });

    const add = await call(env, "POST", "/auth/callsigns", { callsign: "OE9ZZZ" }, { cookie: me.cookie });
    expect(add.status).toBe(200);
    expect(add.data.licence).toEqual({ callsign: "OE9ZZZ", status: "unconfirmed" });
    const add2 = await call(env, "POST", "/auth/callsigns", { callsign: "W0OLD" }, { cookie: me.cookie });
    expect(add2.status).toBe(200);
    expect(add2.data.licence.status).toBe("expired");

    const list = await call(env, "GET", "/auth/callsigns", undefined, { cookie: me.cookie });
    const by = Object.fromEntries(list.data.callsigns.map((c: any) => [c.callsign, c]));
    expect(by.K0TST.licence.status).toBe("licensed");
    expect(by.K0TST.verified).toBe(false); // validity is not control-verification
    expect(by.OE9ZZZ.licence.status).toBe("unconfirmed");
  });

  it("a registry lookup that fails still lets the call through as unconfirmed", async () => {
    const env = authEnv();
    await env.DB.prepare("DROP TABLE licence_registry").run();
    const me = await emailSignup(env, "a@example.test", "OE9AAA");
    expect(me.status).toBe(200);
    expect(me.data.licence).toEqual({ callsign: "OE9AAA", status: "unconfirmed" });
  });
});
