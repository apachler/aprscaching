// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * config.ts — startup config helpers for the ingest daemon.
 *  - loadDotEnv: the `pnpm dev` / `start` paths run plain `tsx`/`node` with no dotenv, so without this
 *    the box silently starts as N0CALL/change-me. Load a `.env` from cwd if present; a real process-env
 *    value always wins.
 *  - numEnv: parse a numeric env var with validation + a floor. A blank/NaN value (e.g. `BATCH_MS=`)
 *    must NOT silently become 0 — that's a ~1 ms flush loop, or a socket dialling port 0.
 */
import fs from "node:fs";

/** Load KEY=VALUE lines from a dotenv file into process.env (existing keys are never overwritten). */
export function loadDotEnv(file = ".env"): void {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return; // no .env — fine, env may come from the shell / container
  }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    if (!key || key in process.env) continue; // real env wins
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'")))
      val = val.slice(1, -1);
    process.env[key] = val;
  }
}

/**
 * Parse a numeric env var. A missing/blank value → `def`; a non-numeric value → `def` (warned); a value
 * outside `[min,max]` is clamped (warned). `Number(env.X ?? d)` returns 0 for an empty string (the `??`
 * only guards null/undefined), which would become a tight flush loop or port 0.
 */
export function numEnv(name: string, def: number, opts: { min?: number; max?: number } = {}): number {
  const raw = process.env[name];
  if (raw == null || raw.trim() === "") return def;
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    console.warn(`[config] ${name}="${raw}" is not a number — using ${def}`);
    return def;
  }
  if (opts.min != null && n < opts.min) {
    console.warn(`[config] ${name}=${n} is below the minimum ${opts.min} — using ${opts.min}`);
    return opts.min;
  }
  if (opts.max != null && n > opts.max) {
    console.warn(`[config] ${name}=${n} is above the maximum ${opts.max} — using ${opts.max}`);
    return opts.max;
  }
  return n;
}

/** A TCP/UDP port from env, validated to [1,65535] (a blank/NaN port must not dial 0). */
export const portEnv = (name: string, def: number): number => numEnv(name, def, { min: 1, max: 65535 });
