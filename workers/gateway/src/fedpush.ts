// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * fedpush.ts — push-to-hub: NAT/firewall peers contribute without inbound reachability. A spoke
 * pushes sync pages of its own signed frames to a hub (pushToHub) — every feed the pull serves — a few
 * seconds after a local write (pushSoon) and in every frequent sync; the hub binds the submitter's
 * identity and admits the frames through the same path as a pull (handleFederationSubmit).
 */
import type { Env } from "./env.js";
import { json } from "./app.js";
import { secretOk } from "./auth.js";
import { nowS } from "./util/time.js";
import { fedFetch, readCappedBody, trimTrailingSlashes } from "./fetchguard.js";
import {
  isInstanceId,
  loadRegistry,
  parseAcceptKeys,
  resolvePeerKeys,
  usableKeys,
  CACHE_FEED,
  FIND_FEED,
  KEY_FEED,
  type FeedServeDef,
  type RotationRecord,
  type RegistryEntry,
} from "./federation.js";
import { TOMBSTONE_FEED } from "./tombstones.js";
import { BULLETIN_FEED } from "./bbs.js";
import { ACCOUNT_MOVE_FEED } from "./account.js";
import { decodeFedSyncPage, encodeFedSyncPage, buildFedFrames } from "./fedsync.js";
import { decodeFedFrame } from "@aprscaching/shared";
import { type TrustLevel, absorbDiscovered, ours } from "./fedpeers.js";
import { admitFrame, type FrameGate } from "./fedapply.js";
import { MAX_PAGES } from "./fedpull.js";
import { signRelayRequest, spokeAuth } from "./relay.js";
import { markGen, markOf, rotationsJson, setMark, ORIGIN_KINDS, type OriginKind } from "./fedtransit.js";
import { addGap } from "./fedgaps.js";

/**
 * The feeds a spoke pushes: every feed the pull serves, in the pull's order (fedapply.ts `SYNC_DEFS`) —
 * tombstones first, so a delete suppresses a re-mirror.
 */
export const PUSH_FEEDS: FeedServeDef[] = [
  TOMBSTONE_FEED,
  CACHE_FEED,
  FIND_FEED,
  KEY_FEED,
  ACCOUNT_MOVE_FEED,
  BULLETIN_FEED,
];
/** Largest submission body the hub reads: a full page of frames fits well inside it. */
const MAX_SUBMIT_BYTES = 4 * 1024 * 1024;

/**
 * HUB endpoint: accept a spoke's signed records and mirror them as if we had pulled them
 * (push-mode mirroring — same remote_* tables, same display-only semantics). Secret-gated; optionally
 * restricted to an instance allowlist. Each record is verified against the supplied key and MUST name
 * the submitter as its signer, so a spoke can only contribute records as ITSELF — never impersonate
 * another instance. A spoke that rotated its key sends its rotation records in `x-fed-rotations`.
 */
export async function handleFederationSubmit(req: Request, env: Env): Promise<Response> {
  const secret = env.FED_SUBMIT_SECRET;
  if (!secret) return json({ ok: false, error: "submit disabled" }, { status: 403 });
  if (!secretOk(req.headers.get("x-fed-secret"), secret))
    return json({ ok: false, error: "unauthorized" }, { status: 401 });

  // A submission is a sync page of fedwire frames — the same signed bytes every other carrier
  // moves. The page's instance declares the submitter; every frame must be signed by ONE key (a
  // submission is one spoke), verified over the frame bytes verbatim.
  if (!(req.headers.get("content-type") ?? "").includes("application/cbor"))
    return json({ ok: false, error: "submit is application/cbor (a fedwire sync page)" }, { status: 415 });
  const body = await readCappedBody(req, MAX_SUBMIT_BYTES);
  if (!body) return json({ ok: false, error: "submission too large" }, { status: 413 });
  let page: ReturnType<typeof decodeFedSyncPage>;
  try {
    page = decodeFedSyncPage(body);
  } catch {
    return json({ ok: false, error: "not a CBOR sync page" }, { status: 400 });
  }
  if (!isInstanceId(page.instance))
    return json({ ok: false, error: "submitter instance id is not a hostname" }, { status: 400 });
  let rotations: RotationRecord[] = [];
  try {
    const h = req.headers.get("x-fed-rotations");
    if (h && h.length <= 16_384) rotations = (JSON.parse(h) as RotationRecord[]).slice(0, 32);
  } catch {
    return json({ ok: false, error: "x-fed-rotations is not a JSON array of rotation records" }, { status: 400 });
  }
  // A submission is one spoke, so every frame must verify under ONE key: the first frame's names it,
  // and the identity checks below decide whether the hub accepts that key for the instance.
  let submitKey: string | null = null;
  for (const fb of page.frames) {
    try {
      submitKey = decodeFedFrame(fb).signerKey;
      break;
    } catch {
      continue;
    }
  }
  if (!submitKey) return json({ ok: false, error: "no verifiable frames" }, { status: 400 });
  // where the spoke's page starts, so the hub knows whether it continues what it holds of the spoke
  const sinceRaw = req.headers.get("x-fed-since");
  const since = sinceRaw && /^\d+$/.test(sinceRaw) ? Number(sinceRaw) : NaN;
  return submitFrames(env, page.instance, submitKey, page.frames, rotations, {
    ...page,
    ...(Number.isSafeInteger(since) && since >= 0 && { since }),
  });
}

/** A spoke's position in one feed: its cursor and, mid-pass in a composite feed, the id tie-breaker. */
interface PushMark {
  cursor: number;
  id?: number;
}

/**
 * The feed a page carries, named as its sync type: the record kind of its first decodable frame (a spoke
 * pushes one feed per page).
 */
function pageFeed(frames: Uint8Array[]): string | null {
  for (const fb of frames) {
    try {
      const kind = decodeFedFrame(fb).record.kind;
      return kind === "accountMove" ? "account-move" : kind;
    } catch {
      continue;
    }
  }
  return null;
}

/** The sequence a frame claims, before any check: where a page stops being held when that frame did not settle. */
function claimedSeq(fb: Uint8Array): number {
  try {
    return decodeFedFrame(fb).record.v;
  } catch {
    return 0;
  }
}

async function recordMark(env: Env, instance: string, type: string, mark: PushMark): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO fed_submit_marks (instance, type, cursor, cursor_id, submitted_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (instance, type) DO UPDATE SET cursor = excluded.cursor, cursor_id = excluded.cursor_id,
       submitted_at = excluded.submitted_at`,
  )
    .bind(instance, type, mark.cursor, mark.id ?? null, nowS())
    .run();
}

/**
 * HUB endpoint: where each of the calling spoke's feeds stands here — its cursor after the last page this
 * hub admitted. A spoke asks when it starts and when it comes back online, and resumes from these marks:
 * restored from a backup it skips what the hub has; after the hub was restored it re-pushes what the hub
 * lost. Needs the submit secret and a request signed with the spoke's federation key, so a spoke reads
 * only its own marks.
 */
export async function handleSubmitMarks(req: Request, env: Env): Promise<Response> {
  const secret = env.FED_SUBMIT_SECRET;
  if (!secret) return json({ ok: false, error: "submit disabled" }, { status: 403 });
  if (!secretOk(req.headers.get("x-fed-secret"), secret))
    return json({ ok: false, error: "unauthorized" }, { status: 401 });
  const instance = (req.headers.get("x-relay-instance") ?? "").toLowerCase();
  if (!(await spokeAuth(req, env, instance, new Uint8Array(0))))
    return json({ ok: false, error: "not signed by a spoke this hub knows" }, { status: 401 });
  const rows = (
    await env.DB.prepare("SELECT type, cursor, cursor_id FROM fed_submit_marks WHERE instance = ?")
      .bind(instance)
      .all<{ type: string; cursor: number; cursor_id: number | null }>()
  ).results;
  const marks: Record<string, PushMark> = {};
  for (const r of rows) marks[r.type] = { cursor: r.cursor, ...(r.cursor_id != null && { id: r.cursor_id }) };
  return json({ ok: true, instance, marks });
}

/**
 * The submit core: allowlist, the registry + TOFU key binding and spoke registration, then every frame
 * through the shared admission path (fedapply.ts) under the bound key — the same signature, origin,
 * namespace, tombstone and version checks as a pulled frame. A submission carries mirror records only.
 */
async function submitFrames(
  env: Env,
  instance: string,
  publicKey: string,
  frames: Uint8Array[],
  rotations: RotationRecord[] = [],
  page?: { nextCursor: number; nextId?: number; since?: number },
): Promise<Response> {
  if (instance === ours(env)) return json({ ok: false, error: "cannot submit as this instance" }, { status: 400 });
  const allow = (env.FED_SUBMIT_INSTANCES ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (allow.length && !allow.includes(instance))
    return json({ ok: false, error: "instance not allowed" }, { status: 403 });

  // A secret-holder must not be able to impersonate a KNOWN instance. The signed registry binding
  // wins; otherwise the submitted key must be one the hub already verified for this instance, under
  // ANY row — a pulled peer, a 44net or registry entry, or an earlier submission. A shared secret is
  // not an identity, so a blocked instance stays out and a new spoke enters unvetted until the
  // operator promotes it.
  let registry: Map<string, RegistryEntry>;
  try {
    registry = await loadRegistry(env);
  } catch {
    return json({ ok: false, error: "federation registry is misconfigured on this hub" }, { status: 503 });
  }
  const regEntry = registry.get(instance);
  if (regEntry?.key && regEntry.key !== publicKey)
    return json({ ok: false, error: "submitted key does not match the registry for this instance" }, { status: 403 });
  // a spoke that discovery listed becomes the spoke its pushes register
  await absorbDiscovered(env, instance);
  const known = (
    await env.DB.prepare("SELECT url, public_key, accept_keys, trust FROM fed_peers WHERE instance = ?")
      .bind(instance)
      .all<{ url: string; public_key: string | null; accept_keys: string | null; trust: TrustLevel }>()
  ).results;
  if (known.some((r) => r.trust === "blocked"))
    return json({ ok: false, error: "instance is blocked on this hub" }, { status: 403 });
  for (const r of known) {
    const accept = parseAcceptKeys(r.accept_keys);
    const keys = accept.length ? usableKeys(accept, nowS()) : r.public_key ? [r.public_key] : [];
    if (!keys.length || keys.includes(publicKey)) continue;
    // A spoke that rotated proves it the same way a pulled peer does: rotation records (sent in
    // x-fed-rotations) leading from its pinned key to the new one. Only its own submit row moves.
    if (r.url === `submit:${instance}` && r.public_key) {
      const moved = await resolvePeerKeys({
        pinned: r.public_key,
        current: publicKey,
        published: [{ x: publicKey }, ...accept.filter((k) => k.x !== publicKey)],
        rotations,
        prior: accept,
        nowS: nowS(),
        graceDays: env.FED_ROTATION_GRACE_DAYS ? Number(env.FED_ROTATION_GRACE_DAYS) : undefined,
      });
      if (moved.ok) {
        await env.DB.prepare("UPDATE fed_peers SET public_key = ?, accept_keys = ?, rotations = ? WHERE url = ?")
          .bind(moved.pin, JSON.stringify(moved.accept), rotationsJson(rotations), r.url)
          .run();
        continue;
      }
    }
    return json({ ok: false, error: "submitted key does not match the key known for this instance" }, { status: 403 });
  }

  // Register a new spoke as a never-pulled peer so its mirrored records carry a uniform trust
  // binding: enabled=0 keeps it out of the pull set, and the synthetic `submit:<instance>` url
  // marks how it arrived.
  if (!known.length)
    await env.DB.prepare(
      "INSERT OR IGNORE INTO fed_peers (url, instance, public_key, accept_keys, trust, added_via, enabled) VALUES (?, ?, ?, ?, 'unvetted', 'submitted', 0)",
    )
      .bind(`submit:${instance}`, instance, publicKey, JSON.stringify([{ x: publicKey }]))
      .run();

  const gate: FrameGate = { origin: instance, keysFor: () => Promise.resolve([publicKey]), mirrorOnly: true };
  let applied = 0,
    rejected = 0;
  const unsettled: number[] = [];
  for (const fb of frames) {
    const r = await admitFrame(env, fb, gate);
    if (r.verdict === "applied") applied++;
    else if (r.verdict === "rejected") rejected++;
    if (!r.settled) unsettled.push(claimedSeq(fb));
  }
  // How far this spoke's feed now stands here, returned so the spoke resumes from what the hub holds.
  const type = page ? pageFeed(frames) : null;
  let mark: (PushMark & { type: string }) | undefined;
  let held: number | undefined;
  if (page && type) {
    mark = { type, cursor: page.nextCursor, ...(page.nextId !== undefined && { id: page.nextId }) };
    await recordMark(env, instance, type, mark);
    // a page that continues what the hub holds of the spoke: the hub now holds it up to the page's end, the records
    // that did not settle aside, which become gaps (fedgaps.ts), and passes that on like any origin it pulled
    if ((ORIGIN_KINDS as readonly string[]).includes(type)) {
      const kind = type as OriginKind;
      const gen = await markGen(env, instance);
      held = await markOf(env, instance, kind);
      let upTo = page.nextCursor;
      if (page.since !== undefined && page.since <= held)
        for (const v of unsettled.sort((a, b) => a - b))
          if (v > held && v <= upTo && !(await addGap(env, instance, kind, v, "unsettled"))) upTo = v - 1;
      if (page.since !== undefined && page.since <= held && upTo > held) {
        await setMark(env, instance, kind, upTo, gen);
        held = await markOf(env, instance, kind);
      }
    }
  }
  // `held`: how far the hub holds this feed of the spoke whole, so a spoke whose pages stopped joining up (the
  // hub forgot what it held, or a page did not settle) sends again from there
  return json({ ok: true, applied, rejected, ...(mark && { mark }), ...(held !== undefined && { held }) });
}

/** How one push cycle ended: what it sent, whether more waits, and why it stopped early. */
export interface PushResult {
  pushed: number;
  /** A feed still had pages past this cycle's MAX_PAGES: run again soon rather than at the next interval. */
  backlog: boolean;
  /** `network`: the hub did not answer (offline, or a gateway in front of it reporting it down). */
  failure?: "network" | "refused";
}

/** Hubs whose marks this process has read since it started; reconnecting reads them again. */
const MARKS_READ = new Set<string>();

const loadCursor = async (env: Env, hub: string, type: string): Promise<PushMark> => {
  const r = await env.DB.prepare("SELECT cursor, cursor_id FROM fed_push_cursors WHERE hub = ? AND type = ?")
    .bind(hub, type)
    .first<{ cursor: number; cursor_id: number | null }>();
  return r ? { cursor: r.cursor, ...(r.cursor_id != null && { id: r.cursor_id }) } : { cursor: 0 };
};
/** Where the push of one feed last went back to, at the hub's word. */
const rewoundTo = async (env: Env, hub: string, type: string): Promise<number | null> =>
  (
    await env.DB.prepare("SELECT rewound_to FROM fed_push_cursors WHERE hub = ? AND type = ?")
      .bind(hub, type)
      .first<{ rewound_to: number | null }>()
  )?.rewound_to ?? null;
const setRewoundTo = (env: Env, hub: string, type: string, v: number | null) =>
  env.DB.prepare("UPDATE fed_push_cursors SET rewound_to = ? WHERE hub = ? AND type = ?").bind(v, hub, type).run();
const saveCursor = (env: Env, hub: string, type: string, m: PushMark) =>
  env.DB.prepare(
    `INSERT INTO fed_push_cursors (hub, type, cursor, cursor_id, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (hub, type) DO UPDATE SET cursor = excluded.cursor, cursor_id = excluded.cursor_id,
       updated_at = excluded.updated_at`,
  )
    .bind(hub, type, m.cursor, m.id ?? null, nowS())
    .run();

/** Record how a push cycle went, for the operator's view and the reconnect probe. */
async function recordHubStatus(env: Env, hub: string, failure: PushResult["failure"], error?: string): Promise<void> {
  const t = nowS();
  if (!failure)
    await env.DB.prepare(
      `INSERT INTO fed_hub_status (hub, last_attempt_at, last_ok_at, last_error, offline_since) VALUES (?, ?, ?, NULL, NULL)
       ON CONFLICT (hub) DO UPDATE SET last_attempt_at = excluded.last_attempt_at, last_ok_at = excluded.last_ok_at,
         last_error = NULL, offline_since = NULL`,
    )
      .bind(hub, t, t)
      .run();
  else
    await env.DB.prepare(
      `INSERT INTO fed_hub_status (hub, last_attempt_at, last_error, offline_since) VALUES (?, ?, ?, ?)
       ON CONFLICT (hub) DO UPDATE SET last_attempt_at = excluded.last_attempt_at, last_error = excluded.last_error,
         offline_since = CASE WHEN excluded.offline_since IS NULL THEN NULL
                              ELSE COALESCE(fed_hub_status.offline_since, excluded.offline_since) END`,
    )
      .bind(hub, t, (error ?? failure).slice(0, 300), failure === "network" ? t : null)
      .run();
}

/** A hub answer that means the hub itself is unreachable (its proxy or tunnel reports it down). */
const hubDown = (status: number) => status === 502 || status === 503 || status === 504;

/**
 * Take the hub's marks for our feeds as the cursors: they say what the hub actually holds, which after a
 * backup restore on either side differs from our own cursors. A feed without a mark starts from 0, and a
 * hub without the endpoint (404) keeps our cursors. Returns a failure when the hub could not be reached.
 */
async function readMarks(
  env: Env,
  hub: string,
  secret: string,
  fetchFn: (url: string, init?: RequestInit) => Promise<Response>,
): Promise<PushResult["failure"] | null> {
  const url = `${hub}/federation/submit/marks`;
  const signed = await signRelayRequest(env, "GET", url);
  if (!signed) return null;
  let res: Response;
  try {
    res = await fetchFn(url, { headers: { "x-fed-secret": secret, ...signed }, signal: AbortSignal.timeout(5000) });
  } catch {
    return "network";
  }
  if (hubDown(res.status)) return "network";
  if (res.ok) {
    const body = (await res.json().catch(() => null)) as { marks?: Record<string, PushMark> } | null;
    if (body?.marks)
      for (const def of PUSH_FEEDS) {
        const m = body.marks[def.type];
        // no mark: the hub holds nothing of this feed from us (it was restored, or never got it), so from 0
        await saveCursor(env, hub, def.type, m && Number.isFinite(m.cursor) ? m : { cursor: 0 });
      }
  }
  MARKS_READ.add(hub);
  return null;
}

/**
 * SPOKE side: push our signed records to a configured hub (push-mode mirroring) when we can't be
 * pulled — a sync page of fedwire frames, the same signed bytes as every other carrier. Each feed resumes
 * from its persisted cursor, which advances only after the hub's 2xx, to the mark the hub returns; the
 * hub's marks are read once per process and again with `resync` (after an outage), so a restore on either
 * side resumes from what the hub holds. Re-sending a page is harmless (the hub upserts by global id).
 * Null unless FED_HUB_URL + FED_SUBMIT_SECRET + a signing key are present. Cycles run one after another
 * (the frequent sync, Sync now and the push after a write share one queue), so a page is never sent twice
 * from the same cursor at once.
 */
export function pushToHub(
  env: Env,
  fetchFn: (url: string, init?: RequestInit) => Promise<Response> = (u, i) => fedFetch(env, u, i),
  opts: { resync?: boolean } = {},
): Promise<PushResult | null> {
  const run = pushQueue.then(() => pushCycle(env, fetchFn, opts));
  pushQueue = run.catch(() => null);
  return run;
}
let pushQueue: Promise<unknown> = Promise.resolve();

async function pushCycle(
  env: Env,
  fetchFn: (url: string, init?: RequestInit) => Promise<Response>,
  opts: { resync?: boolean },
): Promise<PushResult | null> {
  const hub = env.FED_HUB_URL ? trimTrailingSlashes(env.FED_HUB_URL) : undefined;
  const secret = env.FED_SUBMIT_SECRET;
  if (!hub || !secret || !env.INSTANCE) return null;
  const stop = async (r: PushResult, error?: string): Promise<PushResult> => {
    await recordHubStatus(env, hub, r.failure, error);
    return r;
  };
  if (opts.resync || !MARKS_READ.has(hub)) {
    const failure = await readMarks(env, hub, secret, fetchFn);
    if (failure) return stop({ pushed: 0, backlog: false, failure }, "the hub did not answer");
  }
  let pushed = 0;
  let backlog = false;
  for (const def of PUSH_FEEDS) {
    let { cursor, id } = await loadCursor(env, hub, def.type);
    for (let page = 0; ; page++) {
      if (page === MAX_PAGES) {
        backlog = true;
        break;
      }
      const built = await buildFedFrames(env, env.INSTANCE, def.type, cursor, 500, id);
      if (!built) return null; // no signing key — nothing verifiable to push
      if (!built.frames.length) break;
      const complete = built.frames.length < 500;
      let res: Response;
      try {
        res = await fetchFn(`${hub}/federation/submit`, {
          method: "POST",
          headers: {
            "content-type": "application/cbor",
            "x-fed-secret": secret,
            // where this page starts: the hub holds our records whole only while the pages it takes join up
            "x-fed-since": String(cursor),
            // our rotation records, so a hub that pinned an earlier key can follow the rotation
            ...(env.FED_ROTATIONS ? { "x-fed-rotations": env.FED_ROTATIONS } : {}),
          },
          body: encodeFedSyncPage(env.INSTANCE, built.nextCursor, complete, built.frames, built.nextId) as BodyInit,
          signal: AbortSignal.timeout(5000),
        });
      } catch (e) {
        return stop({ pushed, backlog, failure: "network" }, (e as Error).message);
      }
      // stop; the cursor stays, so the next cycle sends this page again
      if (!res.ok)
        return stop(
          { pushed, backlog, failure: hubDown(res.status) ? "network" : "refused" },
          `hub answered ${res.status}`,
        );
      // as on the pull side, the id tie-breaker is kept only while more pages of this pass remain
      const sent: PushMark = {
        cursor: built.nextCursor,
        ...(!complete && built.nextId !== undefined && { id: built.nextId }),
      };
      const answer = (await res.json().catch(() => null)) as {
        mark?: PushMark & { type?: string };
        held?: unknown;
      } | null;
      const mark = answer?.mark?.type === def.type && Number.isFinite(answer.mark.cursor) ? answer.mark : null;
      let next: PushMark = mark ? { cursor: mark.cursor, ...(mark.id != null && !complete && { id: mark.id }) } : sent;
      // the hub holds this feed of ours whole only up to below where this page started: send again from there,
      // so the pages join up and the hub passes our records on
      // once for each place the hub names, so a hub that cannot take the pages whole never keeps us resending
      const held = typeof answer?.held === "number" && Number.isSafeInteger(answer.held) ? answer.held : null;
      const before = await rewoundTo(env, hub, def.type);
      const rewind = held !== null && held >= 0 && held < cursor && held !== before;
      if (rewind) next = { cursor: held };
      await saveCursor(env, hub, def.type, next);
      // a page that joined up clears it: should the hub forget us again later, we go back again
      if (rewind || (held !== null && held >= cursor && before !== null))
        await setRewoundTo(env, hub, def.type, rewind ? held : null);
      pushed += built.frames.length;
      if (rewind) {
        cursor = next.cursor;
        id = undefined;
        continue;
      }
      if (complete || (built.nextCursor === cursor && built.nextId === id)) break;
      cursor = next.cursor;
      id = next.id;
    }
  }
  return stop({ pushed, backlog });
}

/** The pause after a local write before the push, and the longest a stream of writes may hold it back. */
export const PUSH_SOON_DELAY_MS = 3000;
export const PUSH_SOON_MAX_WAIT_MS = 15_000;

let soon: { timer: ReturnType<typeof setTimeout>; first: number } | null = null;
let afterPushSoon: ((r: PushResult) => void) | null = null;

/**
 * Hand each push-after-write outcome to the host's catch-up loop (fedcatchup.ts), so a network failure
 * starts its probes and a backlog its early cycle, as after a scheduled push.
 */
export function onPushSoon(fn: ((r: PushResult) => void) | null): void {
  afterPushSoon = fn;
}

/**
 * Push to the hub shortly after a local write: {@link PUSH_SOON_DELAY_MS} after the last write, so a burst
 * (a find and its photo, a cache and its stages) goes in one cycle, and at most
 * {@link PUSH_SOON_MAX_WAIT_MS} after the first, so a steady stream of writes still goes out. Skipped while
 * the hub is known to be unreachable: the catch-up probe pushes the moment it answers. A no-op without a
 * hub; a cycle with nothing new sends nothing.
 */
export function pushSoon(env: Env): void {
  if (!env.FED_HUB_URL || !env.FED_SUBMIT_SECRET || !env.INSTANCE) return;
  const now = Date.now();
  const first = soon?.first ?? now;
  if (soon) clearTimeout(soon.timer);
  const wait = Math.max(0, Math.min(PUSH_SOON_DELAY_MS, first + PUSH_SOON_MAX_WAIT_MS - now));
  const timer = setTimeout(() => {
    soon = null;
    void pushAfterWrite(env).catch((e) => console.error("push after write:", (e as Error).message));
  }, wait);
  // a pending push never holds the process open
  (timer as { unref?: () => void }).unref?.();
  soon = { timer, first };
}

async function pushAfterWrite(env: Env): Promise<void> {
  const hub = trimTrailingSlashes(env.FED_HUB_URL ?? "");
  const st = await env.DB.prepare("SELECT offline_since FROM fed_hub_status WHERE hub = ?")
    .bind(hub)
    .first<{ offline_since: number | null }>();
  if (st?.offline_since != null) return; // backing off: the catch-up probe pushes when the hub answers
  const r = await pushToHub(env);
  if (r) afterPushSoon?.(r);
}

/** Records past the persisted push cursor, per feed, counted up to `cap` (more shows as the cap). */
export async function pushBacklog(env: Env, hub: string, cap = 1000): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const def of PUSH_FEEDS) {
    const { cursor, id } = await loadCursor(env, hub, def.type);
    out[def.type] = (await def.selectRows(env, cursor, cap, def.composite ? id : undefined)).length;
  }
  return out;
}
