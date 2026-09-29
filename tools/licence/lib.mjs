// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-check
// The licence-register import: download a register, parse it on this machine, keep one row per call
// (callsign, status, expiry — nothing else), and post the rows in batches to the gateway, then close the
// run so the gateway drops calls the register no longer lists. Names and addresses in the register files
// are read past and never leave this machine.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { spawn } from "node:child_process";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

/** Rows per POST; the gateway accepts at most 1000. */
export const BATCH = 1000;

/**
 * Request headers that authorise an import: the operator machine's secret. Kept in one place so the
 * credential can change without touching the import logic.
 * @param {string} secret
 */
export const authHeaders = (secret) => ({ "content-type": "application/json", "x-ingest-secret": secret });

/** A row outranks another when it is licensed and the other is not, then when it expires later (no expiry = latest). */
const better = (
  /** @type {{status: string, expiresAt: number | null}} */ a,
  /** @type {{status: string, expiresAt: number | null}} */ b,
) => (a.status !== b.status ? a.status === "licensed" : (a.expiresAt ?? Infinity) > (b.expiresAt ?? Infinity));

/**
 * The text lines of a PDF, through `pdftotext` (poppler-utils). A `.txt` file is read as it is, so an
 * operator without poppler can extract the text with any tool that keeps reading order.
 * @param {string} file @returns {AsyncIterable<string>}
 */
export async function* textLines(file) {
  if (!/\.pdf$/i.test(file)) {
    yield* readline.createInterface({ input: fs.createReadStream(file, "utf8"), crlfDelay: Infinity });
    return;
  }
  const child = spawn("pdftotext", ["-enc", "UTF-8", file, "-"], { stdio: ["ignore", "pipe", "inherit"] });
  const failed = new Promise((_, reject) =>
    child.on("error", (e) =>
      reject(
        /** @type {NodeJS.ErrnoException} */ (e).code === "ENOENT"
          ? new Error("pdftotext not found — install poppler-utils, or pass --file with a text extraction")
          : e,
      ),
    ),
  );
  failed.catch(() => {});
  child.stdout.setEncoding("utf8");
  yield* readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  const code = await Promise.race([new Promise((r) => child.on("close", r)), failed]);
  if (code !== 0) throw new Error(`pdftotext exited with ${String(code)}`);
}

/**
 * The rows of one register file, one per call (the best row where the file lists a call twice).
 * @param {any} source a module from sources/ @param {string} file
 * @returns {AsyncIterable<import("./sources/common.mjs").LicenceRow>}
 */
export async function* readSource(source, file) {
  /** @type {Map<string, import("./sources/common.mjs").LicenceRow>} */
  const best = new Map();
  const rows = source.text ? source.parseText(textLines(file)) : source.parse(file);
  for await (const row of rows) {
    const had = best.get(row.callsign);
    if (!had || better(row, had)) best.set(row.callsign, row);
  }
  yield* best.values();
}

/** The download URL of a source: fixed, or the current edition linked from its page. */
async function sourceUrl(/** @type {any} */ source, /** @type {typeof fetch} */ doFetch) {
  if (source.url) return source.url;
  const res = await doFetch(source.page);
  if (!res.ok) throw new Error(`${source.id}: ${source.page} answered ${res.status}`);
  const href = source.pdfLink.exec(await res.text())?.[1];
  if (!href) throw new Error(`${source.id}: no list linked from ${source.page}`);
  return new URL(href.replace(/&amp;/g, "&"), source.page).href;
}

/** Download a source to `dir`; returns the file path. */
export async function download(/** @type {any} */ source, /** @type {string} */ dir, doFetch = fetch) {
  const url = await sourceUrl(source, doFetch);
  const res = await doFetch(url);
  if (!res.ok || !res.body) throw new Error(`${source.id}: ${url} answered ${res.status}`);
  const file = path.join(dir, source.file);
  await pipeline(Readable.fromWeb(/** @type {any} */ (res.body)), fs.createWriteStream(file));
  return file;
}

/** POST JSON, retrying a network error or a 5xx up to three times. */
async function post(
  /** @type {typeof fetch} */ doFetch,
  /** @type {string} */ url,
  /** @type {string} */ secret,
  body,
) {
  for (let attempt = 1; ; attempt++) {
    let res;
    try {
      res = await doFetch(url, { method: "POST", headers: authHeaders(secret), body: JSON.stringify(body) });
    } catch (e) {
      if (attempt >= 3) throw e;
      await new Promise((r) => setTimeout(r, 1000 * attempt));
      continue;
    }
    if (res.status >= 500 && attempt < 3) {
      await new Promise((r) => setTimeout(r, 1000 * attempt));
      continue;
    }
    const data = await res.json().catch(() => null);
    if (res.status === 401) throw new Error("refused: the secret does not match the gateway's INGEST_SECRET");
    if (!res.ok) throw new Error(`${url} answered ${res.status}: ${data?.error ?? "unexpected response"}`);
    return data;
  }
}

/**
 * Import one source into the gateway at `base`: download it (unless `file` is given), parse, post the
 * rows in batches under one `importedAt`, and close the run. `dryRun` parses and counts without posting.
 * @param {{ source: any, base: string, secret?: string, file?: string, dryRun?: boolean, importedAt?: number,
 *           fetch?: typeof fetch, log?: (msg: string) => void, workDir?: string }} opts
 */
export async function importSource(opts) {
  const { source, base } = opts;
  const doFetch = opts.fetch ?? fetch;
  const log = opts.log ?? ((m) => console.log(m));
  let file = opts.file;
  let tmp = null;
  if (!file) {
    tmp = fs.mkdtempSync(path.join(opts.workDir ?? os.tmpdir(), `licence-${source.id}-`));
    log(`${source.id}: downloading`);
    file = await download(source, tmp, doFetch);
  }
  try {
    const importedAt = opts.importedAt ?? Math.floor(Date.now() / 1000);
    const root = base.replace(/\/+$/, "");
    let batch = [];
    let parsed = 0;
    let accepted = 0;
    const flush = async () => {
      if (!batch.length) return;
      if (!opts.dryRun) {
        const r = await post(doFetch, `${root}/api/licence/import`, opts.secret ?? "", {
          source: source.id,
          importedAt,
          rows: batch,
        });
        accepted += Number(r?.accepted ?? 0);
      }
      batch = [];
    };
    for await (const row of readSource(source, file)) {
      parsed++;
      batch.push([row.callsign, row.status, row.expiresAt]);
      if (batch.length >= BATCH) await flush();
    }
    await flush();
    if (opts.dryRun) {
      log(`${source.id}: ${parsed} calls parsed (dry run, nothing sent)`);
      return { source: source.id, parsed, accepted: 0, removed: 0 };
    }
    if (accepted === 0) throw new Error(`${source.id}: no calls parsed — nothing imported, nothing pruned`);
    const fin = await post(doFetch, `${root}/api/licence/import/finish`, opts.secret ?? "", {
      source: source.id,
      importedAt,
      count: accepted,
    });
    log(`${source.id}: ${accepted} calls imported, ${Number(fin?.removed ?? 0)} no longer listed removed`);
    return { source: source.id, parsed, accepted, removed: Number(fin?.removed ?? 0) };
  } finally {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  }
}
