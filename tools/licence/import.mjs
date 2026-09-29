#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-check
// Import public amateur licence registers into a gateway, for the callsign validity badge.
//
//   BASE=https://api.example.net INGEST_SECRET=… node tools/licence/import.mjs --source fcc
//   node tools/licence/import.mjs --source fcc,ised,acma,at,de
//   node tools/licence/import.mjs --source all             # every register below
//   node tools/licence/import.mjs --source de --file rufzeichenliste.pdf   # a file already on disk
//   node tools/licence/import.mjs --source ised --dry-run  # parse and count, send nothing
//   node tools/licence/import.mjs --list
//
// With no --source, the LICENCE_SOURCES environment variable names the registers (comma-separated), so
// a scheduled run (cron, systemd timer) needs only the environment. Each register is parsed here; only
// callsign, status and expiry are sent. BASE defaults to http://127.0.0.1:8787. The PDF registers
// (at, de) need `pdftotext` from poppler-utils. Exits non-zero if any register fails.
import { SOURCES } from "./sources/index.mjs";
import { importSource } from "./lib.mjs";

const args = process.argv.slice(2);
const flag = (/** @type {string} */ name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

if (args.includes("--list") || args.includes("--help")) {
  console.log(
    "usage: BASE=<gateway> INGEST_SECRET=<secret> node tools/licence/import.mjs --source <ids|all> [--file <path>] [--dry-run]\n",
  );
  for (const s of Object.values(SOURCES)) console.log(`  ${s.id.padEnd(5)} ${s.country}  ${s.name}`);
  process.exit(0);
}

const base = flag("--base") ?? process.env.BASE ?? "http://127.0.0.1:8787";
const secret = process.env.INGEST_SECRET;
const dryRun = args.includes("--dry-run");
const file = flag("--file");
const wanted = (flag("--source") ?? process.env.LICENCE_SOURCES ?? "").trim();
const ids =
  wanted === "all"
    ? Object.keys(SOURCES)
    : wanted
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean);

if (!ids.length) {
  console.error("name the registers with --source <ids|all> or LICENCE_SOURCES (see --list)");
  process.exit(2);
}
const unknown = ids.filter((id) => !SOURCES[id]);
if (unknown.length) {
  console.error(`unknown register: ${unknown.join(", ")} (see --list)`);
  process.exit(2);
}
if (file && ids.length !== 1) {
  console.error("--file imports one register; name exactly one --source");
  process.exit(2);
}
if (!dryRun && !secret) {
  console.error("INGEST_SECRET is required to import (or pass --dry-run)");
  process.exit(2);
}

let failed = 0;
for (const id of ids) {
  try {
    await importSource({ source: SOURCES[id], base, secret, file, dryRun });
  } catch (e) {
    failed++;
    console.error(`${id}: ${/** @type {Error} */ (e).message}`);
  }
}
process.exit(failed ? 1 : 0);
