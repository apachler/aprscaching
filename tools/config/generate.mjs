#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Renders everything that restates the configuration schema (packages/shared/src/config.ts, its keys in
 * configkeys.ts and its prose in configdocs.ts):
 *
 *   docs/reference/configuration.md   the key tables, between `<!-- config-table:<id> -->` markers, each
 *                                     site setting marked, and the site-settings table
 *   .env.example, deploy/.env.example from the layouts in envfiles.mjs
 *   deploy/lib/config-keys.tsv        what the deploy helpers read (one key per line, tab-separated)
 *   deploy/lib/config-keys.json       the same for automation
 *
 *   node tools/config/generate.mjs           write the files
 *   node tools/config/generate.mjs --check   fail when a file differs from what it would write
 *
 * It also refuses a schema the outputs cannot represent honestly: a key in a table or an env layout that
 * the schema does not list, a schema key no table documents, a secret with a value in an example file, and
 * a documented literal default that differs from the schema's.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { ENV_FILES } from "./envfiles.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const check = process.argv.includes("--check");

// The schema is TypeScript; bundle it in memory and import the result.
const bundled = await build({
  entryPoints: [join(root, "packages/shared/src/configdocs.ts")],
  bundle: true,
  format: "esm",
  platform: "node",
  write: false,
  logLevel: "silent",
});
const { CONFIG_KEYS, CONFIG_HINTS, CONFIG_TABLES, SITE_GROUPS, SITE_GROUP_TITLES, SITE_TEXT, shapesOf } = await import(
  `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`
);

const errors = [];
const names = Object.keys(CONFIG_KEYS);
const known = new Set(names);
// Upper-case words in a table that are protocol vocabulary or examples, not settings.
const NOT_KEYS = new Set(["APRSCG", "FOUND", "DNF", "NOTE", "HELP", "N0CALL", "GET", "POST", "SIGHUP", "TXT"]);
const backticked = (cell) =>
  [...cell.matchAll(/`([A-Z][A-Z0-9_]{2,})`/g)].map((m) => m[1]).filter((k) => !NOT_KEYS.has(k));

// ---- configuration.md tables
const documented = new Set();
const isSite = (k) => CONFIG_KEYS[k]?.site !== undefined;
// a row whose every key is a site setting says so, and links the precedence rule
const SITE_MARK = " · *[Instance setting](#instance-settings)*";
const renderTable = (t) => {
  const line = (cells) => `| ${cells.join(" | ")} |`;
  const out = [line(t.header), line(t.header.map(() => "---")).replace(/ /g, "")];
  for (const row of t.rows) {
    // the key column is the first, except in the transports table, whose keys sit in its second
    const keyCells = t.header[0] === "Variable" ? [row[0]] : [row[1]];
    for (const k of keyCells.flatMap(backticked)) {
      if (!known.has(k)) errors.push(`configdocs.ts table ${t.id}: ${k} is not in the schema`);
      documented.add(k);
    }
    const keys = backticked(row[0]);
    const def = row[row.length - 1].match(/^`([^`]*)`$/)?.[1];
    if (t.header.at(-1) === "Default" && keys.length === 1 && def !== undefined && known.has(keys[0])) {
      const schemaDefault = CONFIG_KEYS[keys[0]].default;
      if (schemaDefault !== undefined && schemaDefault !== def)
        errors.push(`${keys[0]}: the table says default \`${def}\`, the schema says "${schemaDefault}"`);
    }
    const rowKeys = t.header[0] === "Variable" ? backticked(row[0]) : [];
    const site = rowKeys.length > 0 && rowKeys.every(isSite);
    if (rowKeys.some(isSite) && !site)
      errors.push(`configdocs.ts table ${t.id}: ${rowKeys.join(", ")} mixes site settings with other keys`);
    out.push(line(site ? [row[0], `${row[1]}${SITE_MARK}`, ...row.slice(2)] : row));
  }
  return out.join("\n");
};

/** What a site setting accepts, in words, from its schema entry. */
function accepts(k) {
  const c = CONFIG_KEYS[k];
  const s = c.site;
  const range = s.min !== undefined ? `${s.min}–${s.max}${s.unit ? ` ${s.unit}` : ""}` : "";
  if (c.type === "int") return `a whole number, ${range}`;
  if (c.type === "number") return `a number, ${range}`;
  if (c.type === "enum")
    return c.values.includes("1") ? "on or off" : `one of ${c.values.map((v) => `\`${v}\``).join(", ")}`;
  if (s.format === "contacts") return "email or `https:` addresses, up to 5";
  if (s.format === "links") return "donation links (a label and an http(s) address), up to 12";
  if (s.format === "retention") return "a period per table, each a whole number";
  if (s.options) return `any of ${s.options.map((v) => `\`${v}\``).join(", ")}`;
  if (s.format === "email") return "an email address";
  return `one line of text, up to ${s.maxLength ?? 200} characters`;
}
const siteTable = () => {
  const out = ["| Setting | Variable | Group | Accepts |", "|---|---|---|---|"];
  for (const g of SITE_GROUPS)
    for (const k of names.filter((n) => CONFIG_KEYS[n].site?.group === g))
      out.push(`| ${SITE_TEXT[k].label} | \`${k}\` | ${SITE_GROUP_TITLES[g]} | ${accepts(k)} |`);
  return out.join("\n");
};
const CONFIG_MD = "docs/reference/configuration.md";
let md = readFileSync(join(root, CONFIG_MD), "utf8");
for (const t of CONFIG_TABLES) {
  const re = new RegExp(`(<!-- config-table:${t.id} -->\\n)[\\s\\S]*?(<!-- /config-table -->)`);
  if (!re.test(md)) errors.push(`${CONFIG_MD}: no marker for table ${t.id}`);
  md = md.replace(re, (_, open, close) => `${open}${renderTable(t)}\n${close}`);
}
for (const k of names) if (!documented.has(k)) errors.push(`${k} is in the schema but in no table of configdocs.ts`);
{
  const re = /(<!-- site-settings-table -->\n)[\s\S]*?(<!-- \/site-settings-table -->)/;
  if (!re.test(md)) errors.push(`${CONFIG_MD}: no marker for the site-settings table`);
  md = md.replace(re, (_, open, close) => `${open}${siteTable()}\n${close}`);
}

// ---- .env.example files
const envOut = ENV_FILES.map(({ path, lines }) => {
  const text = lines.map((l) => {
    if (typeof l === "string") return l;
    if (!known.has(l.key)) errors.push(`${path}: ${l.key} is not in the schema`);
    else if (CONFIG_KEYS[l.key].secret && l.value && !l.placeholder)
      errors.push(`${path}: secret ${l.key} carries a value`);
    const value = l.value ?? CONFIG_KEYS[l.key]?.default ?? "";
    return `${l.off ? "# " : ""}${l.key}=${value}`;
  });
  return [path, `${text.join("\n")}\n`];
});

// ---- the deploy helpers' export
const rows = names.map((n) => {
  const k = CONFIG_KEYS[n];
  return {
    name: n,
    type: k.type,
    units: k.units,
    default: k.default ?? "",
    values: k.values ?? [],
    secret: Boolean(k.secret),
    publicRequired: Boolean(k.publicRequired),
    shapes: shapesOf(n),
    hint: CONFIG_HINTS[n],
    ...(k.site ? { site: k.site.group } : {}),
  };
});
for (const r of rows)
  if (/[\t\n]/.test(r.hint + r.default) || r.hint.length > 100) errors.push(`${r.name}: hint must be one short line`);
const tsv =
  "# Generated by tools/config/generate.mjs from packages/shared/src/config.ts — do not edit.\n" +
  "# name\ttype\tunits\tdefault\tvalues\tsecret\tpublicRequired\tshapes\thint\tsite\n" +
  rows
    .map((r) =>
      [
        r.name,
        r.type,
        r.units.join(","),
        r.default,
        r.values.join("|"),
        +r.secret,
        +r.publicRequired,
        r.shapes.join(","),
        r.hint,
        r.site ?? "",
      ].join("\t"),
    )
    .join("\n") +
  "\n";
// one key per line, so a change to a key is a one-line diff
const json = `{"generatedFrom":"packages/shared/src/config.ts","keys":[\n${rows.map((r) => JSON.stringify(r)).join(",\n")}\n]}\n`;

if (errors.length) {
  for (const e of errors) console.error(`✗ ${e}`);
  process.exit(1);
}

const outputs = [
  [CONFIG_MD, md],
  ...envOut,
  ["deploy/lib/config-keys.tsv", tsv],
  ["deploy/lib/config-keys.json", json],
];
let stale = 0;
for (const [path, text] of outputs) {
  let cur = null;
  try {
    cur = readFileSync(join(root, path), "utf8");
  } catch {
    // a missing file is stale
  }
  if (cur === text) continue;
  if (check) {
    console.error(`✗ ${path} is out of date — run node tools/config/generate.mjs`);
    stale++;
  } else {
    writeFileSync(join(root, path), text);
    console.log(`wrote ${path}`);
  }
}
if (stale) process.exit(1);
if (check) console.log(`✓ configuration outputs match the schema (${names.length} keys)`);
