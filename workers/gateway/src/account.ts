// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * account.ts — account data lifecycle: GDPR data export + erasure (right of access / erasure), and
 * account portability across federation peers. Sensitive actions are authorised by a signature from
 * a device key already registered to the callsign (or a matching passkey session) — see
 * accountActionMessage(). The server speaks SI/public data; this is where a user takes their data
 * out or has it removed.
 */
import type { Env } from "./env.js";
import { json } from "./app.js";
import { accountActionMessage } from "@aprsweb/shared";
import { importVerifyKey, fromB64, serveFeed, type FeedServeDef } from "./federation.js";
import { emitTombstones } from "./tombstones.js";
import { isKeyRegistered } from "./keys.js";
import { sessionCallsign } from "./auth.js";

const now = () => Math.floor(Date.now() / 1000);
const instanceOf = (env: Env, req: Request) => env.INSTANCE ?? new URL(req.url).host;

type AuthResult = { ok: true; body: any } | { ok: false; res: Response };

/** Authorise a signed account action (or a matching session). Consumes the JSON body. */
async function authorize(env: Env, req: Request, callsign: string, action: string): Promise<AuthResult> {
  const cs = callsign.toUpperCase();
  const body = (await req.json().catch(() => ({}))) as { key?: string; sig?: string; at?: number; [k: string]: unknown };
  const session = await sessionCallsign(req, env);
  if (session && session.toUpperCase() === cs) return { ok: true, body };
  if (!body.key || !body.sig || !body.at)
    return { ok: false, res: json({ error: "signed action required (key, sig, at) or a matching session" }, { status: 401 }) };
  if (Math.abs(now() - body.at) > 300)
    return { ok: false, res: json({ error: "stale signature (>5 min)" }, { status: 401 }) };
  if (!(await isKeyRegistered(env, cs, body.key)))
    return { ok: false, res: json({ error: "key not registered to this callsign" }, { status: 403 }) };
  try {
    const key = await importVerifyKey(body.key);
    const msg = new TextEncoder().encode(accountActionMessage({ action, callsign: cs, instance: instanceOf(env, req), at: body.at }));
    const valid = await crypto.subtle.verify("Ed25519", key, fromB64(body.sig), msg);
    if (!valid) return { ok: false, res: json({ error: "invalid signature" }, { status: 401 }) };
  } catch { return { ok: false, res: json({ error: "invalid key/signature" }, { status: 401 }) }; }
  return { ok: true, body };
}

const rows = async (env: Env, sql: string, ...binds: unknown[]) =>
  (await env.DB.prepare(sql).bind(...binds).all()).results;

// ----------------------------------------------------- GDPR: export everything for a callsign
export async function handleAccountExport(req: Request, env: Env, callsign: string): Promise<Response> {
  const auth = await authorize(env, req, callsign, "export");
  if (!auth.ok) return auth.res;
  const cs = callsign.toUpperCase();
  const data = {
    instance: instanceOf(env, req),
    callsign: cs,
    exportedAt: now(),
    account: await env.DB.prepare("SELECT callsign, verified, verify_method, created_at, verified_at FROM accounts WHERE callsign=?").bind(cs).first(),
    caches: await rows(env, "SELECT id, code, title, type, status, lat, lon, created_at FROM caches WHERE owner_call=?", cs),
    logs: await rows(env, "SELECT cache_id, ts, log_type, verified, tier, comment, signer_key, signed_at FROM cache_logs WHERE logger_call=? ORDER BY ts", cs),
    positions: await rows(env, "SELECT ts, lat, lon, heard_via, source FROM positions WHERE callsign=? ORDER BY ts", cs),
    keys: await rows(env, "SELECT public_key, label, verified, created_at FROM callsign_keys WHERE callsign=?", cs),
    favorites: await rows(env, "SELECT cache_id FROM favorites WHERE callsign=?", cs),
    watches: await rows(env, "SELECT cache_id FROM watches WHERE callsign=?", cs),
    achievements: await rows(env, "SELECT badge, earned_at FROM achievements WHERE callsign=?", cs),
    verifications: await rows(env, "SELECT method, status, verified_at FROM callsign_verifications WHERE callsign=?", cs),
    stations: await rows(env, "SELECT callsign, lat, lon, symbol, description, roles, created_at FROM account_stations WHERE callsign=? OR callsign LIKE ?", cs, `${cs}-%`),
    weatherKeys: await rows(env, "SELECT callsign, station_id, created_at, last_seen FROM wx_keys WHERE callsign=?", cs),
    uiPrefs: await env.DB.prepare("SELECT prefs FROM account_prefs WHERE account_id=(SELECT account_id FROM accounts WHERE callsign=?)").bind(cs).first(),
  };
  return json(data, { headers: { "content-disposition": `attachment; filename="aprscaching-${cs}.json"` } });
}

// ----------------------------------------------------- GDPR: erase / anonymise a callsign's data
export async function handleAccountDelete(req: Request, env: Env, callsign: string): Promise<Response> {
  const auth = await authorize(env, req, callsign, "delete");
  if (!auth.ok) return auth.res;
  const cs = callsign.toUpperCase();
  const instance = instanceOf(env, req);
  // Capture this callsign's federated find ids BEFORE anonymising — once logger_call becomes
  // WITHDRAWN we can't find them, and peers mirrored them with the real call (PII). The finds feed is
  // append-only by id, so an UPDATE never re-serves the anonymised row → a tombstone is the only way
  // to purge the pre-deletion copies on peers (T1.3/ADR-5).
  const findIds = (await env.DB.prepare("SELECT id FROM cache_logs WHERE logger_call=?").bind(cs).all<{ id: number }>()).results;
  // Anonymise finds (keep cache integrity/counts, drop PII), erase personal records, tombstone.
  await env.DB.batch([
    env.DB.prepare("UPDATE cache_logs SET logger_call='WITHDRAWN', comment=NULL, signer_key=NULL, author_sig=NULL WHERE logger_call=?").bind(cs),
    // archive owned caches AND bump updated_at so the archival re-propagates through the caches feed
    // (peers re-mirror status='archived' → the cache drops off their maps); no cache tombstone needed.
    env.DB.prepare("UPDATE caches SET owner_call='WITHDRAWN', status='archived', updated_at=? WHERE owner_call=?").bind(now(), cs),
    env.DB.prepare("UPDATE messages SET from_call='WITHDRAWN' WHERE from_call=?").bind(cs),
    env.DB.prepare("DELETE FROM positions WHERE callsign=?").bind(cs),
    env.DB.prepare("DELETE FROM callsign_keys WHERE callsign=?").bind(cs),
    env.DB.prepare("DELETE FROM favorites WHERE callsign=?").bind(cs),
    env.DB.prepare("DELETE FROM watches WHERE callsign=?").bind(cs),
    env.DB.prepare("DELETE FROM achievements WHERE callsign=?").bind(cs),
    env.DB.prepare("DELETE FROM stage_unlocks WHERE callsign=?").bind(cs),
    env.DB.prepare("DELETE FROM callsign_verifications WHERE callsign=?").bind(cs),
    env.DB.prepare("DELETE FROM account_stations WHERE callsign=? OR callsign LIKE ?").bind(cs, `${cs}-%`),
    env.DB.prepare("DELETE FROM wx_keys WHERE callsign=?").bind(cs),
    // account-level UI prefs — delete BEFORE the accounts row (the subselect needs account_id)
    env.DB.prepare("DELETE FROM account_prefs WHERE account_id IN (SELECT account_id FROM accounts WHERE callsign=?)").bind(cs),
    env.DB.prepare("DELETE FROM accounts WHERE callsign=?").bind(cs),
    env.DB.prepare("INSERT OR REPLACE INTO account_events (callsign, action, detail, at) VALUES (?, 'deleted', NULL, ?)").bind(cs, now()),
  ]);
  // emit PII-free find tombstones so the network purges the mirrored copies that still carry the call
  const tombstones = await emitTombstones(env, instance, findIds.map((r) => ({ kind: "find" as const, targetId: `${instance}:find:${r.id}` })));
  return json({ ok: true, erased: cs, tombstones });
}

// ----------------------------------------------------- portability: signed migration bundle (source)
export async function handleAccountBundle(req: Request, env: Env, callsign: string): Promise<Response> {
  const auth = await authorize(env, req, callsign, "migrate");
  if (!auth.ok) return auth.res;
  const cs = callsign.toUpperCase();
  const acct = await env.DB.prepare("SELECT verified FROM accounts WHERE callsign=?").bind(cs).first<{ verified: number }>();
  const keys = (await rows(env, "SELECT public_key AS publicKey, label, verified FROM callsign_keys WHERE callsign=?", cs));
  return json({
    bundle: { v: 1, instance: instanceOf(env, req), callsign: cs, verified: (acct?.verified ?? 0) === 1, keys, at: now() },
  });
}

// ----------------------------------------------------- portability: mark moved (source)
export async function handleAccountMove(req: Request, env: Env, callsign: string): Promise<Response> {
  const auth = await authorize(env, req, callsign, "migrate");
  if (!auth.ok) return auth.res;
  const target = String(auth.body.target ?? "").trim();
  if (!target) return json({ error: "target instance required" }, { status: 400 });
  const cs = callsign.toUpperCase();
  await env.DB.prepare("INSERT OR REPLACE INTO account_events (callsign, action, detail, at) VALUES (?, 'moved', ?, ?)").bind(cs, target, now()).run();
  return json({ ok: true, callsign: cs, movedTo: target });
}

// ----------------------------------------------------- portability: import a bundle (target)
export async function handleAccountImport(req: Request, env: Env): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as { bundle?: any; assertion?: { key?: string; sig?: string; at?: number } };
  const bundle = body.bundle, a = body.assertion;
  if (!bundle?.callsign || !Array.isArray(bundle.keys) || !a?.key || !a?.sig || !a?.at)
    return json({ error: "bundle + assertion (key, sig, at) required" }, { status: 400 });
  const cs = String(bundle.callsign).toUpperCase();

  // the mover must prove control of the account: the assertion key must be one of the bundle's keys,
  // signed over an action bound to THIS (target) instance.
  if (!bundle.keys.some((k: any) => k.publicKey === a.key))
    return json({ error: "assertion key is not in the bundle" }, { status: 403 });
  if (Math.abs(now() - a.at) > 300) return json({ error: "stale assertion" }, { status: 401 });
  try {
    const key = await importVerifyKey(a.key);
    const msg = new TextEncoder().encode(accountActionMessage({ action: "migrate", callsign: cs, instance: instanceOf(env, req), at: a.at }));
    if (!(await crypto.subtle.verify("Ed25519", key, fromB64(a.sig), msg)))
      return json({ error: "invalid migration assertion" }, { status: 401 });
  } catch { return json({ error: "invalid assertion" }, { status: 401 }); }

  const exists = await env.DB.prepare("SELECT callsign FROM accounts WHERE callsign=?").bind(cs).first();
  if (exists) return json({ error: "callsign already exists here" }, { status: 409 });

  // SR-SEC-05: the bundle is CLIENT-supplied and unsigned by any source instance — the device-key
  // assertion only proves the mover controls a key THEY put in the bundle, which says nothing about the
  // callsign. So we must NOT trust `bundle.verified` (that would let anyone import W1AW as "verified").
  // The account + its keys land UNVERIFIED; the operator re-proves control on this instance via the APRS
  // control-challenge. (A source-instance-signed bundle could restore verified status — a federation
  // follow-on once cross-instance bundle signing exists.)
  const stmts = [
    env.DB.prepare("INSERT INTO accounts (callsign, verified, verify_method, created_at) VALUES (?, 0, 'migrated', ?)")
      .bind(cs, now()),
    env.DB.prepare("INSERT OR REPLACE INTO account_events (callsign, action, detail, at) VALUES (?, 'moved', ?, ?)")
      .bind(cs, `from:${bundle.instance ?? "?"}`, now()),
    // T3.2: announce the move to the network — the target attests "this callsign now homes here",
    // signed at serve time on the account-move feed so peers can re-point attribution (ADR-2).
    env.DB.prepare("INSERT INTO account_moves (callsign, from_instance, to_instance, ts) VALUES (?,?,?,?)")
      .bind(cs, bundle.instance ?? null, instanceOf(env, req), now()),
  ];
  for (const k of bundle.keys)
    stmts.push(env.DB.prepare("INSERT OR IGNORE INTO callsign_keys (callsign, public_key, label, verified, created_at) VALUES (?,?,?, 0, ?)")
      .bind(cs, k.publicKey, k.label ?? null, now()));
  await env.DB.batch(stmts);
  return json({ ok: true, callsign: cs, importedKeys: bundle.keys.length, from: bundle.instance ?? null });
}

// ----------------------------------------------------- federation: account-move feed (T3.2)
interface MoveRow { seq: number; callsign: string; from_instance: string | null; to_instance: string; ts: number }
const ACCOUNT_MOVE_FEED: FeedServeDef<MoveRow> = {
  type: "account-move",
  selectRows: async (env, since, limit) => (await env.DB.prepare(
    "SELECT seq, callsign, from_instance, to_instance, ts FROM account_moves WHERE seq > ? ORDER BY seq LIMIT ?",
  ).bind(since, limit).all<MoveRow>()).results,
  recordOf: (r, instance) => ({
    id: `${instance}:move:${r.seq}`, cursor: r.seq,
    data: { callsign: r.callsign, fromInstance: r.from_instance, toInstance: r.to_instance, ts: r.ts },
  }),
};
export const handleFederationAccountMoves = (req: Request, env: Env): Promise<Response> => serveFeed(req, env, ACCOUNT_MOVE_FEED);
