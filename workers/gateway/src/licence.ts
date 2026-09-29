// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * licence.ts — callsign VALIDITY from public licence registers: is this a real, currently licensed
 * amateur call? It is a flag, never a gate. A call no imported register lists is "unconfirmed" (many
 * countries publish nothing), never "invalid", and nothing is refused because of it. It is also distinct
 * from control-verification (callsign.ts), which proves that the person controls the call.
 *
 *   GET  /api/licence/:call           {callsign, status: licensed|expired|unconfirmed, source?, sourceName?,
 *                                      expiresAt?, checkedAt?} — public, read-API rate limited
 *   GET  /api/licence                 the imported registers: row count + import date per source
 *   POST /api/licence/import          one batch of rows for a source run (operator machine secret)
 *   POST /api/licence/import/finish   close a run: prune the rows an older run wrote (operator secret)
 *
 * The import tool (tools/licence/import.mjs) parses the register files on the operator's machine and
 * posts only callsign, status and expiry; names and addresses in those files never reach the gateway.
 * A run stamps every row it writes with its `importedAt`; finishing the run checks that the gateway holds
 * exactly the rows the tool sent, then deletes that source's rows from older runs — so a call dropped
 * from the register disappears, and an interrupted run prunes nothing.
 */
import { nowS } from "./util/time.js";
import type { Env } from "./env.js";
import { baseCall } from "@aprscaching/aprs";
import { json, asStr } from "./app.js";
import { operatorSecretOk } from "./auth.js";
import { readGate } from "./readapi.js";

export type LicenceStatus = "licensed" | "expired" | "unconfirmed";
export interface LicenceResult {
  status: LicenceStatus;
  source?: string;
  sourceName?: string;
  expiresAt?: number;
  checkedAt?: number;
}
export interface RegistryRow {
  source: string;
  status: string;
  expires_at: number | null;
  updated_at: number;
}

/** Display names of the registers the import tool ships; any other source id shows uppercased. */
const SOURCE_NAMES: Record<string, string> = {
  fcc: "FCC",
  ised: "ISED Canada",
  acma: "ACMA",
  at: "Fernmeldebehörde AT",
  de: "Bundesnetzagentur",
};
export const sourceName = (id: string): string => SOURCE_NAMES[id] ?? id.toUpperCase();

/**
 * The home call a raw call string is looked up by. Uppercase, trimmed, the SSID (`-n`) and a trailing
 * `*` dropped. A portable form (`OE/DL1ABC/P`, `W1AW/KH6`, `VE3/W1AW`) splits on `/` and keeps the
 * longest part shaped like a callsign — letters and digits only, at least one digit, ending in a letter,
 * 3–10 characters — so a country prefix (`OE`, `VE3`, `KH6`) or an operating suffix (`P`, `M`, `MM`,
 * `QRP`) is never taken for the home call. The first such part wins a tie. Null when no part qualifies.
 */
export function homeCall(raw: string): string | null {
  let best: string | null = null;
  for (const seg of raw.toUpperCase().trim().replace(/\*$/, "").split("/")) {
    const part = baseCall(seg);
    if (!CALL_SHAPE.test(part)) continue;
    if (!best || part.length > best.length) best = part;
  }
  return best;
}
const CALL_SHAPE = /^(?=[A-Z0-9]*[0-9])[A-Z0-9]{2,9}[A-Z]$/;

/** The one answer for a call from all register rows that list it: a current listing wins, then the
 *  latest expiry, then the most recent import. A licensed row past its expiry reads as expired. */
export function resolveLicence(rows: RegistryRow[], nowS: number): LicenceResult {
  if (rows.length === 0) return { status: "unconfirmed" };
  const effective = (r: RegistryRow): "licensed" | "expired" =>
    r.status === "licensed" && (r.expires_at == null || r.expires_at >= nowS) ? "licensed" : "expired";
  const ranked = [...rows].sort(
    (a, b) =>
      (effective(b) === "licensed" ? 1 : 0) - (effective(a) === "licensed" ? 1 : 0) ||
      (b.expires_at ?? Infinity) - (a.expires_at ?? Infinity) ||
      b.updated_at - a.updated_at,
  );
  const top = ranked[0]!;
  const out: LicenceResult = { status: effective(top), source: top.source, sourceName: sourceName(top.source) };
  if (top.expires_at != null) out.expiresAt = top.expires_at;
  out.checkedAt = top.updated_at;
  return out;
}

/**
 * Look a call up in the registry. Never throws: a registry that is missing or unreadable answers
 * "unconfirmed", so sign-up and adding a call carry on unaffected. Null only when `raw` has no callsign
 * shape at all.
 */
export async function lookupLicence(env: Env, raw: string): Promise<({ callsign: string } & LicenceResult) | null> {
  const callsign = homeCall(raw);
  if (!callsign) return null;
  try {
    const rows =
      (
        await env.DB.prepare("SELECT source, status, expires_at, updated_at FROM licence_registry WHERE callsign = ?")
          .bind(callsign)
          .all<RegistryRow>()
      ).results ?? [];
    return { callsign, ...resolveLicence(rows, nowS()) };
  } catch {
    return { callsign, status: "unconfirmed" };
  }
}

/** The validity result to attach to an auth response; `{callsign, status:"unconfirmed"}` at worst. */
export async function licenceFor(env: Env, raw: string): Promise<{ callsign: string } & LicenceResult> {
  return (await lookupLicence(env, raw)) ?? { callsign: raw.toUpperCase().trim(), status: "unconfirmed" };
}

/** GET /api/licence/:call — public, under the read API's per-IP / per-key rate limit. */
export async function handleLicenceLookup(req: Request, env: Env, rawCall: string): Promise<Response> {
  const g = await readGate(req, env);
  if (g instanceof Response) return g;
  return licenceAnswer(env, rawCall);
}

/** The lookup response for a (still URL-encoded) path segment; the caller has applied the rate limit. */
export async function licenceAnswer(env: Env, rawCall: string): Promise<Response> {
  let raw: string;
  try {
    raw = decodeURIComponent(rawCall);
  } catch {
    return json({ error: "malformed callsign" }, { status: 400 });
  }
  const r = await lookupLicence(env, raw.slice(0, 40));
  if (!r) return json({ error: "not a callsign" }, { status: 400 });
  return json(r, { headers: { "cache-control": "public, max-age=3600" } });
}

/** GET /api/licence — which registers this instance has imported, and when. */
export async function handleLicenceSources(req: Request, env: Env): Promise<Response> {
  const g = await readGate(req, env);
  if (g instanceof Response) return g;
  let rows: Array<{ source: string; rows: number; importedAt: number }> = [];
  try {
    rows =
      (
        await env.DB.prepare(
          "SELECT source, COUNT(*) AS rows, MAX(updated_at) AS importedAt FROM licence_registry GROUP BY source ORDER BY source",
        ).all<{ source: string; rows: number; importedAt: number }>()
      ).results ?? [];
  } catch {
    /* no registry yet */
  }
  return json({ sources: rows.map((r) => ({ ...r, sourceName: sourceName(r.source) })) });
}

// ---- import (operator machine) ----

/**
 * The credential for register imports: the operator secret (`x-operator-secret`). An import rewrites
 * instance-wide data, so it is an operator action, never the ingest box's. Every import route checks
 * through this one helper.
 */
export function operatorMachineOk(req: Request, env: Env): boolean {
  return operatorSecretOk(req, env);
}

const SOURCE_ID = /^[a-z][a-z0-9_-]{0,23}$/;
const ROW_CALL = /^(?=[A-Z0-9]*[0-9])(?=[A-Z0-9]*[A-Z])[A-Z0-9]{3,12}$/;
/** Rows per POST — bounds one request's work on every runtime. */
export const MAX_BATCH = 1000;

type Row = [callsign: string, status: "licensed" | "expired", expiresAt: number | null];

function cleanRow(v: unknown): Row | null {
  if (!Array.isArray(v)) return null;
  const [c, s, e] = v as unknown[];
  const call = asStr(c).toUpperCase();
  if (!ROW_CALL.test(call)) return null;
  if (s !== "licensed" && s !== "expired") return null;
  if (e != null && !(Number.isInteger(e) && (e as number) > 0)) return null;
  return [call, s, (e as number | null) ?? null];
}

async function latestImport(env: Env, source: string): Promise<number> {
  const r = await env.DB.prepare("SELECT MAX(updated_at) AS at FROM licence_registry WHERE source = ?")
    .bind(source)
    .first<{ at: number | null }>();
  return r?.at ?? 0;
}

function runParams(body: Record<string, unknown>): { source: string; importedAt: number } | string {
  const source = asStr(body.source);
  if (!SOURCE_ID.test(source)) return "source must be a short lowercase id";
  const importedAt = body.importedAt;
  if (!Number.isInteger(importedAt) || (importedAt as number) <= 0) return "importedAt must be unix seconds";
  if ((importedAt as number) > nowS() + 3600) return "importedAt is in the future";
  return { source, importedAt: importedAt as number };
}

/**
 * POST /api/licence/import {source, importedAt, rows: [[callsign, status, expiresAt|null], …]}.
 * Upserts the batch under this run's `importedAt`. A call sent twice in one run keeps the better row
 * (a licensed listing over an expired one, then the later expiry). Malformed rows are skipped and
 * counted; extra array members beyond the three fields are ignored, so nothing else is ever stored.
 */
export async function handleLicenceImport(req: Request, env: Env): Promise<Response> {
  if (!operatorMachineOk(req, env)) return json({ error: "unauthorized" }, { status: 401 });
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return json({ error: "JSON body required" }, { status: 400 });
  const run = runParams(body);
  if (typeof run === "string") return json({ error: run }, { status: 400 });
  if (!Array.isArray(body.rows) || body.rows.length > MAX_BATCH)
    return json({ error: `rows must be an array of at most ${MAX_BATCH}` }, { status: 400 });
  if ((await latestImport(env, run.source)) > run.importedAt)
    return json({ error: "a newer import of this source exists" }, { status: 409 });

  const rows = (body.rows as unknown[]).map(cleanRow).filter((r): r is Row => r !== null);
  // One statement per batch: the rows travel as a single JSON parameter and json_each unpacks them, so
  // the batch stays far below D1's per-statement parameter cap and per-request query budget.
  if (rows.length)
    await env.DB.prepare(
      `INSERT INTO licence_registry (callsign, source, status, expires_at, updated_at)
       SELECT json_extract(value, '$[0]'), ?, json_extract(value, '$[1]'), json_extract(value, '$[2]'), ?
         FROM json_each(?) WHERE true
       ON CONFLICT(callsign, source) DO UPDATE SET
         status = excluded.status, expires_at = excluded.expires_at, updated_at = excluded.updated_at
       WHERE licence_registry.updated_at < excluded.updated_at
          OR (licence_registry.updated_at = excluded.updated_at AND (
               (licence_registry.status = 'expired' AND excluded.status = 'licensed')
            OR (licence_registry.status = excluded.status
                AND COALESCE(excluded.expires_at, 9e18) > COALESCE(licence_registry.expires_at, 9e18))))`,
    )
      .bind(run.source, run.importedAt, JSON.stringify(rows))
      .run();
  return json({ ok: true, accepted: rows.length, skipped: (body.rows as unknown[]).length - rows.length });
}

/**
 * POST /api/licence/import/finish {source, importedAt, count} — close a run. `count` is the number of
 * distinct calls the tool had accepted. When the gateway holds exactly that many rows for the run, the
 * source's rows from older runs are deleted (in bounded batches); otherwise nothing is pruned (409), so a
 * run cut short never wipes a register.
 */
export async function handleLicenceImportFinish(req: Request, env: Env): Promise<Response> {
  if (!operatorMachineOk(req, env)) return json({ error: "unauthorized" }, { status: 401 });
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return json({ error: "JSON body required" }, { status: 400 });
  const run = runParams(body);
  if (typeof run === "string") return json({ error: run }, { status: 400 });
  const count = body.count;
  if (!Number.isInteger(count) || (count as number) < 1)
    return json(
      { error: "count must be the number of calls imported (an empty import prunes nothing)" },
      { status: 400 },
    );
  if ((await latestImport(env, run.source)) > run.importedAt)
    return json({ error: "a newer import of this source exists" }, { status: 409 });
  const held = await env.DB.prepare("SELECT COUNT(*) AS n FROM licence_registry WHERE source = ? AND updated_at = ?")
    .bind(run.source, run.importedAt)
    .first<{ n: number }>();
  if ((held?.n ?? 0) !== count)
    return json(
      { error: "the run is incomplete; nothing was pruned", expected: count, held: held?.n ?? 0 },
      { status: 409 },
    );
  let removed = 0;
  for (;;) {
    const r = await env.DB.prepare(
      "DELETE FROM licence_registry WHERE rowid IN (SELECT rowid FROM licence_registry WHERE source = ? AND updated_at < ? LIMIT 5000)",
    )
      .bind(run.source, run.importedAt)
      .run();
    const n = r.meta?.changes ?? 0;
    removed += n;
    if (n < 5000) break;
  }
  return json({ ok: true, source: run.source, rows: count, removed });
}
