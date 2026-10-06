// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * updatecheck.ts — tells the sysop when a newer APRScaching release exists. Once a day the scheduled task asks
 * GitHub for the project's latest release, keeps its tag in `update_check`, and the Setup checklist
 * (`/api/admin/setup`, sysop-only) compares it with the running version. `deploy/aprscaching doctor` relays
 * the same answer.
 *
 * The request carries the instance's own name in its User-Agent and nothing about a member. It is polite: one
 * answer a day at most, `If-None-Match` so an unchanged release costs GitHub a 304, and a short timeout. A
 * failure is logged at debug level and changes nothing — an instance with no route to GitHub (off-grid) simply
 * never shows an update. `UPDATE_CHECK=0` turns the request off.
 */
import type { Env } from "./env.js";
import { setting } from "./siteconfig.js";
import { nowS } from "./util/time.js";
import { APP_VERSION } from "./version.js";

/** The repository releases are published from. A fork that publishes its own releases changes it here. */
export const RELEASE_REPO = "apachler/aprscaching";
const LATEST_URL = `https://api.github.com/repos/${RELEASE_REPO}/releases/latest`;
/** An answer younger than this is kept, so restarts in a row do not repeat the request. */
const MIN_INTERVAL_S = 20 * 3600;
const TIMEOUT_MS = 10_000;

/** What the Setup checklist reports. `latest` is null until a check has succeeded. */
export interface UpdateStatus {
  current: string;
  latest: string | null;
  url: string | null;
  checkedAt: number | null;
  available: boolean;
  /** The desktop app updates by replacing its binary, not with deploy/aprscaching update. */
  desktop: boolean;
}

/** UPDATE_CHECK is on unless set to 0, false or no. */
export const updateCheckOn = (env: Env): boolean =>
  !/^(0|false|no)$/i.test((setting(env, "UPDATE_CHECK") ?? "").trim());

/** A release version as [major, minor, patch]; null for anything else, a prerelease (`1.2.0-rc.1`) included. */
export function parseVersion(v: string | null | undefined): [number, number, number] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec((v ?? "").trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** Whether release `a` is newer than release `b`; false when either is not a release version. */
export function newerThan(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return false;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! > y[i]!;
  return false;
}

interface Row {
  tag: string | null;
  url: string | null;
  etag: string | null;
  checked_at: number;
}

async function readRow(env: Env): Promise<Row | null> {
  return (
    (await env.DB.prepare("SELECT tag, url, etag, checked_at FROM update_check WHERE id = 1").first<Row>()) ?? null
  );
}

async function writeRow(env: Env, row: Row): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO update_check (id, tag, url, etag, checked_at) VALUES (1, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET tag = excluded.tag, url = excluded.url, etag = excluded.etag,
       checked_at = excluded.checked_at`,
  )
    .bind(row.tag, row.url, row.etag, row.checked_at)
    .run();
}

const updateUserAgent = (env: Env): string =>
  `aprscaching/${APP_VERSION} (+https://${env.INSTANCE?.trim() || "unconfigured.invalid"})`;

/**
 * Ask GitHub for the latest release and keep it. Runs from the scheduled task; never throws. `fetchImpl` is the
 * test seam.
 */
export async function runUpdateCheck(env: Env, fetchImpl: typeof fetch = fetch, now = nowS()): Promise<void> {
  if (!updateCheckOn(env)) return;
  try {
    const prev = await readRow(env);
    if (prev && now - prev.checked_at < MIN_INTERVAL_S) return;
    const headers: Record<string, string> = {
      accept: "application/vnd.github+json",
      "user-agent": updateUserAgent(env),
    };
    if (prev?.etag && prev.tag) headers["if-none-match"] = prev.etag;
    const r = await fetchImpl(LATEST_URL, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (r.status === 304 && prev) {
      await writeRow(env, { ...prev, checked_at: now });
      return;
    }
    if (!r.ok) {
      console.debug("update check: GitHub answered %s", r.status);
      return;
    }
    const body = (await r.json()) as { tag_name?: unknown; html_url?: unknown; draft?: unknown; prerelease?: unknown };
    const tag = typeof body.tag_name === "string" ? body.tag_name : null;
    if (body.draft === true || body.prerelease === true || !parseVersion(tag)) {
      // not a release to offer: keep what was known, and ask again tomorrow
      await writeRow(env, { tag: prev?.tag ?? null, url: prev?.url ?? null, etag: null, checked_at: now });
      return;
    }
    const url =
      typeof body.html_url === "string" && body.html_url.startsWith(`https://github.com/${RELEASE_REPO}/`)
        ? body.html_url
        : `https://github.com/${RELEASE_REPO}/releases/tag/${encodeURIComponent(tag!)}`;
    await writeRow(env, { tag, url, etag: r.headers.get("etag"), checked_at: now });
  } catch (e) {
    console.debug("update check: %s", (e as Error).message);
  }
}

/** The update status for the Setup checklist; null when UPDATE_CHECK is off. */
export async function updateStatus(env: Env): Promise<UpdateStatus | null> {
  if (!updateCheckOn(env)) return null;
  // an unreadable row reports no release yet, never an error on the checklist
  const row = await readRow(env).catch(() => null);
  const latest = row?.tag ?? null;
  return {
    current: APP_VERSION,
    latest,
    url: row?.url ?? null,
    checkedAt: row?.checked_at ?? null,
    available: newerThan(latest, APP_VERSION),
    desktop: env.DESKTOP_APP === true,
  };
}
