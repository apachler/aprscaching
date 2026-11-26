#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * What Cloudflare does with a request path under the cache ruleset deploy/cloudflare/cache-rules.sh sends:
 * every rule whose expression matches the path applies in order, a later one overriding an earlier one, as
 * Cloudflare applies its cache rules.
 *
 *   node deploy/test/cf-cache-rules.mjs <ruleset.json> <path>…   prints "<path>\t<cache|bypass|origin>" per path
 *
 * It reads the part of Cloudflare's rules language the script uses (`starts_with`, `ends_with` and `eq` on
 * http.request.uri.path, joined by `and`, `or`, `not` and parentheses) and refuses anything else, so a rule it
 * cannot read fails the check instead of reading as "does not match".
 */
import { readFileSync } from "node:fs";

const FIELD = "http.request.uri.path";

function tokenize(src) {
  const re = /\s*(?:(\()|(\))|(,)|"((?:[^"\\]|\\.)*)"|([A-Za-z_][\w.]*))/y;
  const out = [];
  re.lastIndex = 0;
  while (re.lastIndex < src.length) {
    if (/^\s*$/.test(src.slice(re.lastIndex))) break;
    const at = re.lastIndex;
    const m = re.exec(src);
    if (!m) throw new Error(`cannot read the expression at ${at}: ${src.slice(at, at + 30)}`);
    if (m[1] || m[2] || m[3]) out.push({ p: m[1] ?? m[2] ?? m[3] });
    else if (m[4] !== undefined) out.push({ s: JSON.parse(`"${m[4]}"`) });
    else out.push({ w: m[5] });
  }
  return out;
}

/** Parses an expression into a predicate over the path. */
function compile(src) {
  const t = tokenize(src);
  let i = 0;
  const peek = () => t[i];
  const take = (want) => {
    const x = t[i++];
    const got = x?.p ?? x?.w ?? (x?.s !== undefined ? `"${x.s}"` : "the end");
    if (!x || (want !== undefined && (x.p ?? x.w) !== want)) throw new Error(`expected ${want ?? "more"}, got ${got}`);
    return x;
  };
  const str = () => {
    const x = take();
    if (x.s === undefined) throw new Error(`expected a string, got ${x.p ?? x.w}`);
    return x.s;
  };
  const field = () => {
    const x = take();
    if (x.w !== FIELD) throw new Error(`only ${FIELD} is read, got ${x.w ?? x.p ?? x.s}`);
  };
  function factor() {
    const x = peek();
    if (x?.w === "not") {
      i++;
      const f = factor();
      return (p) => !f(p);
    }
    if (x?.p === "(") {
      i++;
      const e = expr();
      take(")");
      return e;
    }
    if (x?.w === "starts_with" || x?.w === "ends_with") {
      i++;
      take("(");
      field();
      take(",");
      const v = str();
      take(")");
      return x.w === "starts_with" ? (p) => p.startsWith(v) : (p) => p.endsWith(v);
    }
    if (x?.w === FIELD) {
      i++;
      take("eq");
      const v = str();
      return (p) => p === v;
    }
    throw new Error(`cannot read ${x?.w ?? x?.p ?? x?.s ?? "the end"}`);
  }
  function term() {
    let f = factor();
    while (peek()?.w === "and") {
      i++;
      const a = f,
        b = factor();
      f = (p) => a(p) && b(p);
    }
    return f;
  }
  function expr() {
    let f = term();
    while (peek()?.w === "or") {
      i++;
      const a = f,
        b = term();
      f = (p) => a(p) || b(p);
    }
    return f;
  }
  const e = expr();
  if (i !== t.length) throw new Error(`unread rest of the expression: ${src}`);
  return e;
}

const [file, ...paths] = process.argv.slice(2);
if (!file || !paths.length) {
  console.error("usage: cf-cache-rules.mjs <ruleset.json> <path>…");
  process.exit(2);
}
const rules = JSON.parse(readFileSync(file, "utf8")).rules ?? [];
if (!rules.length) {
  console.error(`no rules in ${file}`);
  process.exit(1);
}
let compiled;
try {
  compiled = rules.map((r) => {
    if (r.action !== "set_cache_settings" || typeof r.action_parameters?.cache !== "boolean")
      throw new Error(`a rule that is not a cache on/off setting: ${JSON.stringify(r)}`);
    return { match: compile(r.expression), cache: r.action_parameters.cache };
  });
} catch (e) {
  console.error(`cannot read the ruleset in ${file}: ${e.message}`);
  process.exit(1);
}
for (const p of paths) {
  let verdict = "origin";
  for (const r of compiled) if (r.match(p)) verdict = r.cache ? "cache" : "bypass";
  console.log(`${p}\t${verdict}`);
}
