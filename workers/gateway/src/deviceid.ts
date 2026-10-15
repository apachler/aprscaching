// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * deviceid.ts — names the device behind a station's packets ("Kenwood TM-D710", "Dire Wolf") from the APRS device
 * identification database, aprs-deviceid (https://github.com/aprsorg/aprs-deviceid).
 *
 * The database is CC BY-SA 2.0, so the project neither bundles nor commits it: the gateway fetches the generated
 * `tocalls.dense.json` from `DEVICEID_URL` at runtime, keeps the body in `deviceid_cache`, and every surface that
 * names a device credits the database. The matcher is `@aprscaching/aprs` deviceid.ts; this module only carries
 * the data.
 *
 * Cost and failure: the scheduled task refreshes the copy at most once a day, with `If-None-Match` so an unchanged
 * database costs a 304, a short timeout and a body cap. A failed or malformed answer keeps the last good copy, and
 * with no copy at all a station page names no device. The parsed table stays in memory per database, read from the
 * cached row on first use, so a restart or an offline box keeps naming devices. `DEVICEID_URL` unset or empty turns
 * the fetch and the naming off.
 */
import { buildDeviceIndex, identifyDevice, type DeviceIndex, type DeviceMatch } from "@aprscaching/aprs";
import type { Env } from "./env.js";
import { readCappedBody } from "./fetchguard.js";
import { nowS } from "./util/time.js";
import { APP_VERSION } from "./version.js";

/** A copy checked within this long is kept, so restarts in a row do not repeat the request. */
const MIN_INTERVAL_S = 20 * 3600;
const TIMEOUT_MS = 15_000;
/** The real database is some 40 KB; anything past this is not it. */
const MAX_BODY = 2 * 1024 * 1024;

/** The configured database address; null when the operator turned device naming off. */
export function deviceIdUrl(env: Env): string | null {
  const u = (env.DEVICEID_URL ?? "").trim();
  if (!u || !URL.canParse(u)) return null;
  const { protocol } = new URL(u);
  return protocol === "https:" || protocol === "http:" ? u : null;
}

interface Row {
  body: string | null;
  etag: string | null;
  fetched_at: number | null;
  checked_at: number;
}

/** The parsed table per database: null when there is no usable copy. */
const memory = new WeakMap<object, DeviceIndex | null>();

function parse(body: string | null): DeviceIndex | null {
  if (!body) return null;
  try {
    return buildDeviceIndex(JSON.parse(body));
  } catch {
    return null;
  }
}

async function readRow(env: Env): Promise<Row | null> {
  return (
    (await env.DB.prepare("SELECT body, etag, fetched_at, checked_at FROM deviceid_cache WHERE id = 1").first<Row>()) ??
    null
  );
}

async function writeRow(env: Env, row: Row): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO deviceid_cache (id, body, etag, fetched_at, checked_at) VALUES (1, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET body = excluded.body, etag = excluded.etag, fetched_at = excluded.fetched_at,
       checked_at = excluded.checked_at`,
  )
    .bind(row.body, row.etag, row.fetched_at, row.checked_at)
    .run();
}

/**
 * Fetch the database when the kept copy is a day old, and keep it. Runs from the scheduled task; never throws.
 * `fetchImpl` is the test seam.
 */
export async function refreshDeviceIds(env: Env, fetchImpl: typeof fetch = fetch, now = nowS()): Promise<void> {
  const url = deviceIdUrl(env);
  if (!url) return;
  try {
    const prev = await readRow(env);
    if (prev && now - prev.checked_at < MIN_INTERVAL_S) return;
    const keep: Row = {
      body: prev?.body ?? null,
      etag: prev?.etag ?? null,
      fetched_at: prev?.fetched_at ?? null,
      checked_at: now,
    };
    const headers: Record<string, string> = {
      accept: "application/json",
      "user-agent": `aprscaching/${APP_VERSION} (+https://${env.INSTANCE?.trim() || "unconfigured.invalid"})`,
    };
    if (prev?.etag && prev.body) headers["if-none-match"] = prev.etag;
    let r: Response;
    try {
      r = await fetchImpl(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (e) {
      // offline or unreachable: the check is recorded, so restarts in a row do not repeat it
      console.debug("device database: %s", (e as Error).message);
      await writeRow(env, keep);
      return;
    }
    if (r.status === 304 && prev?.body) {
      await writeRow(env, keep);
      return;
    }
    const bytes = r.ok ? await readCappedBody(r, MAX_BODY) : null;
    const body = bytes ? new TextDecoder().decode(bytes) : null;
    const index = parse(body);
    if (!index) {
      // a failed, oversized or malformed answer keeps the last good copy, and the next try is tomorrow's
      console.debug("device database: no usable answer (%s)", r.status);
      await writeRow(env, keep);
      return;
    }
    await writeRow(env, { body, etag: r.headers.get("etag"), fetched_at: now, checked_at: now });
    memory.set(env.DB, index);
  } catch (e) {
    console.debug("device database: %s", (e as Error).message);
  }
}

/** The device table in use; null when naming is off or no copy was ever fetched. Never throws. */
export async function deviceIndex(env: Env): Promise<DeviceIndex | null> {
  if (!deviceIdUrl(env)) return null;
  if (memory.has(env.DB)) return memory.get(env.DB) ?? null;
  const index = parse((await readRow(env).catch(() => null))?.body ?? null);
  // an absent copy is not remembered, so the first successful refresh is read at once
  if (index) memory.set(env.DB, index);
  return index;
}

/** What a station row keeps to name its device. */
export interface DeviceColumns {
  tocall: string | null;
  mice_prefix: string | null;
  mice_suffix: string | null;
}

/** The device a station's last stored position names; null when naming is off or the table does not know it. */
export async function stationDevice(env: Env, row: DeviceColumns): Promise<DeviceMatch | null> {
  if (!row.tocall && !row.mice_prefix) return null;
  const index = await deviceIndex(env);
  if (!index) return null;
  return identifyDevice(index, {
    dst: row.tocall,
    micE: row.mice_prefix ? { prefix: row.mice_prefix, suffix: row.mice_suffix ?? "" } : null,
  });
}
