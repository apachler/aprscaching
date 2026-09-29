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
import { accountActionMessage } from "@aprscaching/shared";
import { importVerifyKey, fromB64, serveFeed, type FeedServeDef } from "./federation.js";
import { emitTombstones, type TombstoneItem } from "./tombstones.js";
import { isKeyRegistered } from "./keys.js";
import { sessionCallsign, WITHDRAWN } from "./auth.js";

const now = () => Math.floor(Date.now() / 1000);
const instanceOf = (env: Env, req: Request) => env.INSTANCE ?? new URL(req.url).host;

type AuthResult = { ok: true; body: any } | { ok: false; res: Response };

/** Authorise a signed account action (or a matching session). Consumes the JSON body. */
async function authorize(env: Env, req: Request, callsign: string, action: string): Promise<AuthResult> {
  const cs = callsign.toUpperCase();
  const body = (await req.json().catch(() => ({}))) as {
    key?: string;
    sig?: string;
    at?: number;
    [k: string]: unknown;
  };
  const session = await sessionCallsign(req, env);
  if (session && session.toUpperCase() === cs) return { ok: true, body };
  if (!body.key || !body.sig || !body.at)
    return {
      ok: false,
      res: json({ error: "signed action required (key, sig, at) or a matching session" }, { status: 401 }),
    };
  if (Math.abs(now() - body.at) > 300)
    return { ok: false, res: json({ error: "stale signature (>5 min)" }, { status: 401 }) };
  if (!(await isKeyRegistered(env, cs, body.key)))
    return { ok: false, res: json({ error: "key not registered to this callsign" }, { status: 403 }) };
  try {
    const key = await importVerifyKey(body.key);
    const msg = new TextEncoder().encode(
      accountActionMessage({ action, callsign: cs, instance: instanceOf(env, req), at: body.at }),
    );
    const valid = await crypto.subtle.verify("Ed25519", key, fromB64(body.sig), msg);
    if (!valid) return { ok: false, res: json({ error: "invalid signature" }, { status: 401 }) };
  } catch {
    return { ok: false, res: json({ error: "invalid key/signature" }, { status: 401 }) };
  }
  return { ok: true, body };
}

const rows = async (env: Env, sql: string, ...binds: unknown[]) =>
  (
    await env.DB.prepare(sql)
      .bind(...binds)
      .all()
  ).results;

/** The account behind a callsign — its active-call anchor, else the holder of its base call — and
 *  every base call that account holds (the callsign's own base first). */
async function accountScope(
  env: Env,
  cs: string,
): Promise<{ accountId: string | null; email: string | null; calls: string[] }> {
  const base = cs.split("-")[0]!;
  const anchor = await env.DB.prepare("SELECT account_id, email FROM accounts WHERE callsign=?")
    .bind(cs)
    .first<{ account_id: string | null; email: string | null }>();
  const accountId =
    anchor?.account_id ??
    (
      await env.DB.prepare("SELECT account_id FROM account_callsigns WHERE callsign=?")
        .bind(base)
        .first<{ account_id: string }>()
    )?.account_id ??
    null;
  const email =
    anchor?.email ??
    (accountId
      ? ((
          await env.DB.prepare("SELECT email FROM accounts WHERE account_id=?")
            .bind(accountId)
            .first<{ email: string | null }>()
        )?.email ?? null)
      : null);
  const held = accountId
    ? (
        await env.DB.prepare("SELECT callsign FROM account_callsigns WHERE account_id=?")
          .bind(accountId)
          .all<{ callsign: string }>()
      ).results.map((r) => r.callsign.toUpperCase())
    : [];
  return { accountId, email, calls: [...new Set([base, ...held])] };
}

/** `col` names one of `calls` or an SSID of it — a SQL fragment plus its binds. */
function anyCall(col: string, calls: string[]): { sql: string; binds: string[] } {
  return {
    sql: `(${calls.map(() => `${col}=? OR ${col} LIKE ?`).join(" OR ")})`,
    binds: calls.flatMap((c) => [c, `${c}-%`]),
  };
}

// ----------------------------------------------------- GDPR: export everything for a callsign
export async function handleAccountExport(req: Request, env: Env, callsign: string): Promise<Response> {
  const auth = await authorize(env, req, callsign, "export");
  if (!auth.ok) return auth.res;
  const cs = callsign.toUpperCase();
  const data = {
    instance: instanceOf(env, req),
    callsign: cs,
    exportedAt: now(),
    account: await env.DB.prepare(
      "SELECT callsign, verified, verify_method, created_at, verified_at FROM accounts WHERE callsign=?",
    )
      .bind(cs)
      .first(),
    caches: await rows(
      env,
      "SELECT id, code, title, type, status, lat, lon, created_at FROM caches WHERE owner_call=?",
      cs,
    ),
    logs: await rows(
      env,
      "SELECT cache_id, logger_call, ts, log_type, verified, tier, comment, signer_key, signed_at FROM cache_logs WHERE logger_call=? OR logger_call LIKE ? ORDER BY ts",
      cs,
      `${cs}-%`,
    ),
    positions: await rows(
      env,
      "SELECT ts, lat, lon, heard_via, source FROM positions WHERE callsign=? ORDER BY ts",
      cs,
    ),
    keys: await rows(env, "SELECT public_key, label, verified, created_at FROM callsign_keys WHERE callsign=?", cs),
    favorites: await rows(env, "SELECT cache_id FROM favorites WHERE callsign=?", cs),
    watches: await rows(env, "SELECT cache_id FROM watches WHERE callsign=?", cs),
    achievements: await rows(env, "SELECT badge, earned_at FROM achievements WHERE callsign=?", cs),
    verifications: await rows(
      env,
      "SELECT method, status, verified_at, verified_by, note FROM callsign_verifications WHERE callsign=?",
      cs,
    ),
    stations: await rows(
      env,
      "SELECT callsign, lat, lon, symbol, description, roles, created_at FROM account_stations WHERE callsign=? OR callsign LIKE ?",
      cs,
      `${cs}-%`,
    ),
    radioCommands: await rows(
      env,
      "SELECT from_call, command, cache_code, body, raw_text, port, status, reason, sent_at, decided_at FROM radio_commands WHERE from_call=? OR from_call LIKE ? ORDER BY sent_at",
      cs,
      `${cs}-%`,
    ),
    weatherKeys: await rows(
      env,
      "SELECT callsign, station_id, created_at, last_seen FROM wx_keys WHERE callsign=?",
      cs,
    ),
    uiPrefs: await env.DB.prepare(
      "SELECT prefs FROM account_prefs WHERE account_id=(SELECT account_id FROM accounts WHERE callsign=?)",
    )
      .bind(cs)
      .first(),
    ...(await accountExport(env, cs)),
  };
  return json(data, { headers: { "content-disposition": `attachment; filename="aprscaching-${cs}.json"` } });
}

/** The account-scoped part of the export: every row keyed by the account or any call it holds.
 *  Secrets (passkey public keys, push keys, API key values beyond the owner's own) stay out. */
async function accountExport(env: Env, cs: string): Promise<Record<string, unknown>> {
  const { accountId, email, calls } = await accountScope(env, cs);
  const acct = accountId ?? "";
  const by = (col: string) => anyCall(col, calls);
  const q = (sql: string, m: { sql: string; binds: string[] }) => rows(env, sql.replace("$CALLS", m.sql), ...m.binds);
  return {
    passkeys: await q("SELECT id, callsign, transports, created_at FROM credentials WHERE $CALLS", by("callsign")),
    callsigns: await rows(
      env,
      "SELECT callsign, verified, method, verified_at, is_primary, added_at FROM account_callsigns WHERE account_id=?",
      acct,
    ),
    callsignHistory: await rows(
      env,
      "SELECT callsign, set_at, verified FROM callsign_history WHERE account_id=? ORDER BY set_at",
      acct,
    ),
    emailTokens: await rows(
      env,
      "SELECT callsign, purpose, created_at, used FROM email_tokens WHERE email=?",
      email ?? "",
    ),
    watchCalls: await rows(env, "SELECT callsign, added_at FROM watch_calls WHERE account_id=?", acct),
    watchAlerts: await rows(
      env,
      "SELECT callsign, kind, detail, cache_id, lat, lon, ts, seen FROM watch_alerts WHERE account_id=? ORDER BY ts",
      acct,
    ),
    savedViews: await q("SELECT slug, name, state, public, created_at FROM saved_views WHERE $CALLS", by("owner_call")),
    pushSubscriptions: await rows(env, "SELECT endpoint, topics, created_at FROM push_subs WHERE account_id=?", acct),
    boxes: await rows(env, "SELECT box_id, created_at FROM boxes WHERE account_id=?", acct),
    ratings: await q("SELECT cache_id, callsign, stars, ts FROM cache_ratings WHERE $CALLS", by("callsign")),
    cacheMedia: await q(
      "SELECT m.cache_id, m.kind, m.content_type, m.title, m.bytes, m.created_at FROM cache_media m JOIN caches c ON c.id=m.cache_id WHERE $CALLS",
      by("c.owner_call"),
    ),
    rendezvous: await rows(
      env,
      `SELECT cache_a, cache_b, call_a, call_b, ts, lat, lon FROM rendezvous_log WHERE ${by("call_a").sql} OR ${by("call_b").sql}`,
      ...by("call_a").binds,
      ...by("call_b").binds,
    ),
    entitlements: await rows(env, "SELECT key, granted_at FROM entitlements WHERE account_id=?", acct),
    apiKeys: await q(
      "SELECT key, label, rate_tier, created_at, last_used_at FROM api_keys WHERE $CALLS",
      by("owner_call"),
    ),
    whitePages: await q("SELECT callsign, home_bbs, updated_at FROM white_pages WHERE $CALLS", by("callsign")),
    bbsMessages: await rows(
      env,
      `SELECT type, from_call, to_call, subject, body, posted_at, read_at FROM bbs_messages WHERE ${by("from_call").sql} OR (type='P' AND ${by("to_call").sql}) ORDER BY posted_at`,
      ...by("from_call").binds,
      ...by("to_call").binds,
    ),
    stationsOperated: await rows(
      env,
      "SELECT callsign, lat, lon, symbol, description, roles, created_at FROM account_stations WHERE account_id=?",
      acct,
    ),
  };
}

// ----------------------------------------------------- GDPR: erase / anonymise a callsign's data
export async function handleAccountDelete(req: Request, env: Env, callsign: string): Promise<Response> {
  const auth = await authorize(env, req, callsign, "delete");
  if (!auth.ok) return auth.res;
  const cs = callsign.toUpperCase();
  const instance = instanceOf(env, req);
  // Erasure covers the whole person: every base call the account holds, then every account-scoped row.
  const scope = await accountScope(env, cs);
  const calls = [...new Set([cs, ...scope.calls])];
  const tombstoned: TombstoneItem[] = [];
  const mediaKeys: string[] = [];
  for (const c of calls) {
    const erased = await eraseCall(env, instance, c);
    tombstoned.push(...erased.tombstones);
    mediaKeys.push(...erased.mediaKeys);
  }
  await eraseAccount(env, scope.accountId, scope.email, calls);
  // uploaded cache media leaves the object store too; best-effort, the index rows are already gone
  for (const k of mediaKeys) {
    try {
      await env.MEDIA?.delete?.(k);
    } catch {
      /* the row is gone either way */
    }
  }
  // emit PII-free find tombstones so the network purges the mirrored copies that still carry the call
  const tombstones = await emitTombstones(env, instance, tombstoned);
  return json({ ok: true, erased: cs, tombstones });
}

/** Anonymise and erase one callsign's records. Its finds, owned caches and messages are rewritten to a
 *  withdrawn marker unique to this erasure (`WITHDRAWN#…` — the `#` keeps it unregistrable), so find
 *  counts survive and two erased people never collide on a per-caller unique index. */
async function eraseCall(
  env: Env,
  instance: string,
  cs: string,
): Promise<{ tombstones: TombstoneItem[]; mediaKeys: string[] }> {
  const marker = `${WITHDRAWN}#${[...crypto.getRandomValues(new Uint8Array(5))].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
  // Capture this callsign's federated find ids BEFORE anonymising — once logger_call is the withdrawn
  // marker we can't find them, and peers mirrored them with the real call (PII). The finds feed is
  // append-only by id, so an UPDATE never re-serves the anonymised row → a tombstone is the only way
  // to purge the pre-deletion copies on peers. Logs sent from an SSID (a radio find from OE8APR-7) are
  // the callsign's too.
  const findIds = (
    await env.DB.prepare("SELECT id FROM cache_logs WHERE logger_call=? OR logger_call LIKE ?")
      .bind(cs, `${cs}-%`)
      .all<{ id: number }>()
  ).results;
  // the same for the callsign's key bindings and move announcements, which peers mirrored too
  const keyIds = (await env.DB.prepare("SELECT id FROM callsign_keys WHERE callsign=?").bind(cs).all<{ id: number }>())
    .results;
  const moveSeqs = (
    await env.DB.prepare("SELECT seq FROM account_moves WHERE callsign=?").bind(cs).all<{ seq: number }>()
  ).results;
  // media uploaded to the caches this call owns, captured while owner_call still names it
  const media = (
    await env.DB.prepare(
      "SELECT m.id, m.media_key FROM cache_media m JOIN caches c ON c.id=m.cache_id WHERE c.owner_call=?",
    )
      .bind(cs)
      .all<{ id: number; media_key: string }>()
  ).results;
  // Anonymise finds (keep cache integrity/counts, drop PII), erase personal records, tombstone.
  await env.DB.batch([
    // One found per cache survives anonymisation: a find counts once per person, and two of the
    // person's founds (base call and an SSID) would collide on the one-found-per-logger index once
    // both carry the same marker. The dropped copies are tombstoned with the rest.
    env.DB.prepare(
      `DELETE FROM cache_logs WHERE log_type='found' AND (logger_call=? OR logger_call LIKE ?)
         AND id NOT IN (SELECT MIN(id) FROM cache_logs WHERE log_type='found' AND (logger_call=? OR logger_call LIKE ?)
                        GROUP BY cache_id)`,
    ).bind(cs, `${cs}-%`, cs, `${cs}-%`),
    env.DB.prepare(
      "UPDATE cache_logs SET logger_call=?, comment=NULL, signer_key=NULL, author_sig=NULL WHERE logger_call=? OR logger_call LIKE ?",
    ).bind(marker, cs, `${cs}-%`),
    // archive owned caches AND bump updated_at so the archival re-propagates through the caches feed
    // (peers re-mirror status='archived' → the cache drops off their maps); no cache tombstone needed.
    env.DB.prepare("UPDATE caches SET owner_call=?, status='archived', updated_at=? WHERE owner_call=?").bind(
      marker,
      now(),
      cs,
    ),
    env.DB.prepare("UPDATE messages SET from_call=? WHERE from_call=?").bind(marker, cs),
    ...media.map((m) => env.DB.prepare("DELETE FROM cache_media WHERE id=?").bind(m.id)),
    env.DB.prepare("DELETE FROM positions WHERE callsign=?").bind(cs),
    env.DB.prepare("DELETE FROM callsign_keys WHERE callsign=?").bind(cs),
    env.DB.prepare("DELETE FROM account_moves WHERE callsign=?").bind(cs),
    env.DB.prepare("DELETE FROM favorites WHERE callsign=?").bind(cs),
    env.DB.prepare("DELETE FROM watches WHERE callsign=?").bind(cs),
    env.DB.prepare("DELETE FROM achievements WHERE callsign=?").bind(cs),
    env.DB.prepare("DELETE FROM stage_unlocks WHERE callsign=?").bind(cs),
    env.DB.prepare("DELETE FROM callsign_verifications WHERE callsign=?").bind(cs),
    env.DB.prepare(
      "DELETE FROM account_events WHERE callsign=? AND action IN ('sysop_verified', 'sysop_revoked')",
    ).bind(cs),
    env.DB.prepare("DELETE FROM account_stations WHERE callsign=? OR callsign LIKE ?").bind(cs, `${cs}-%`),
    env.DB.prepare("DELETE FROM wx_keys WHERE callsign=?").bind(cs),
    env.DB.prepare("DELETE FROM radio_commands WHERE from_call=? OR from_call LIKE ?").bind(cs, `${cs}-%`),
    // account-level UI prefs — delete BEFORE the accounts row (the subselect needs account_id)
    env.DB.prepare(
      "DELETE FROM account_prefs WHERE account_id IN (SELECT account_id FROM accounts WHERE callsign=?)",
    ).bind(cs),
    env.DB.prepare("DELETE FROM accounts WHERE callsign=?").bind(cs),
    env.DB.prepare(
      "INSERT OR REPLACE INTO account_events (callsign, action, detail, at) VALUES (?, 'deleted', NULL, ?)",
    ).bind(cs, now()),
  ]);
  return {
    tombstones: [
      ...findIds.map((r) => ({ kind: "find" as const, targetId: `${instance}:find:${r.id}` })),
      ...keyIds.map((r) => ({ kind: "key" as const, targetId: `${instance}:key:${r.id}` })),
      ...moveSeqs.map((r) => ({ kind: "move" as const, targetId: `${instance}:move:${r.seq}` })),
    ],
    mediaKeys: media.map((m) => m.media_key),
  };
}

/** Erase every account-scoped row: sign-in material (passkeys, pending ceremonies, email links), the
 *  held calls (freeing each base call), and the person's subscriptions, watches, views, boxes, keys,
 *  ratings, directory entries and personal mail. Public bulletins stay, attributed to the marker. */
async function eraseAccount(env: Env, accountId: string | null, email: string | null, calls: string[]): Promise<void> {
  const by = (col: string) => anyCall(col, calls);
  const del = (sql: string, ...cols: string[]) =>
    env.DB.prepare(cols.reduce((q, col) => q.replace("$CALLS", by(col).sql), sql)).bind(
      ...cols.flatMap((col) => by(col).binds),
    );
  const stmts = [
    del("DELETE FROM credentials WHERE $CALLS", "callsign"),
    del("DELETE FROM auth_challenges WHERE $CALLS", "callsign"),
    del("DELETE FROM email_tokens WHERE $CALLS", "callsign"),
    del("DELETE FROM saved_views WHERE $CALLS", "owner_call"),
    del("DELETE FROM api_keys WHERE $CALLS", "owner_call"),
    del("DELETE FROM cache_ratings WHERE $CALLS", "callsign"),
    del("DELETE FROM rendezvous_log WHERE $CALLS OR $CALLS", "call_a", "call_b"),
    del("DELETE FROM white_pages WHERE $CALLS", "callsign"),
    del("DELETE FROM box_commands WHERE $CALLS", "callsign"),
    del("DELETE FROM bbs_delivery WHERE $CALLS", "to_call"),
    del(
      "DELETE FROM bbs_delivery WHERE msg_id IN (SELECT id FROM bbs_messages WHERE type='P' AND ($CALLS OR $CALLS))",
      "from_call",
      "to_call",
    ),
    del("DELETE FROM bbs_messages WHERE type='P' AND ($CALLS OR $CALLS)", "from_call", "to_call"),
    env.DB.prepare(`UPDATE bbs_messages SET from_call=? WHERE ${by("from_call").sql}`).bind(
      WITHDRAWN,
      ...by("from_call").binds,
    ),
  ];
  if (email) stmts.push(env.DB.prepare("DELETE FROM email_tokens WHERE email=?").bind(email));
  if (accountId)
    for (const table of [
      "account_callsigns",
      "callsign_history",
      "watch_calls",
      "watch_alerts",
      "push_subs",
      "entitlements",
      "wx_keys",
      "account_stations",
      "account_prefs",
      "accounts",
    ])
      stmts.push(env.DB.prepare(`DELETE FROM ${table} WHERE account_id=?`).bind(accountId));
  if (accountId)
    stmts.push(
      env.DB.prepare("DELETE FROM box_commands WHERE box_id IN (SELECT box_id FROM boxes WHERE account_id=?)").bind(
        accountId,
      ),
      env.DB.prepare("DELETE FROM boxes WHERE account_id=?").bind(accountId),
    );
  await env.DB.batch(stmts);
}

// ----------------------------------------------------- portability: signed migration bundle (source)
export async function handleAccountBundle(req: Request, env: Env, callsign: string): Promise<Response> {
  const auth = await authorize(env, req, callsign, "migrate");
  if (!auth.ok) return auth.res;
  const cs = callsign.toUpperCase();
  const acct = await env.DB.prepare("SELECT verified FROM accounts WHERE callsign=?")
    .bind(cs)
    .first<{ verified: number }>();
  const keys = await rows(
    env,
    "SELECT public_key AS publicKey, label, verified FROM callsign_keys WHERE callsign=?",
    cs,
  );
  return json({
    bundle: {
      v: 1,
      instance: instanceOf(env, req),
      callsign: cs,
      verified: (acct?.verified ?? 0) === 1,
      keys,
      at: now(),
    },
  });
}

// ----------------------------------------------------- portability: mark moved (source)
export async function handleAccountMove(req: Request, env: Env, callsign: string): Promise<Response> {
  const auth = await authorize(env, req, callsign, "migrate");
  if (!auth.ok) return auth.res;
  const target = String(auth.body.target ?? "").trim();
  if (!target) return json({ error: "target instance required" }, { status: 400 });
  const cs = callsign.toUpperCase();
  await env.DB.prepare("INSERT OR REPLACE INTO account_events (callsign, action, detail, at) VALUES (?, 'moved', ?, ?)")
    .bind(cs, target, now())
    .run();
  return json({ ok: true, callsign: cs, movedTo: target });
}

// ----------------------------------------------------- portability: import a bundle (target)
export async function handleAccountImport(req: Request, env: Env): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as {
    bundle?: any;
    assertion?: { key?: string; sig?: string; at?: number };
  };
  const bundle = body.bundle,
    a = body.assertion;
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
    const msg = new TextEncoder().encode(
      accountActionMessage({ action: "migrate", callsign: cs, instance: instanceOf(env, req), at: a.at }),
    );
    if (!(await crypto.subtle.verify("Ed25519", key, fromB64(a.sig), msg)))
      return json({ error: "invalid migration assertion" }, { status: 401 });
  } catch {
    return json({ error: "invalid assertion" }, { status: 401 });
  }

  const exists = await env.DB.prepare("SELECT callsign FROM accounts WHERE callsign=?").bind(cs).first();
  if (exists) return json({ error: "callsign already exists here" }, { status: 409 });

  // The bundle is CLIENT-supplied and unsigned by any source instance — the device-key
  // assertion only proves the mover controls a key THEY put in the bundle, which says nothing about the
  // callsign. So we must NOT trust `bundle.verified` (that would let anyone import W1AW as "verified").
  // The account + its keys land UNVERIFIED; the operator re-proves control on this instance via the APRS
  // control-challenge. (A source-instance-signed bundle could restore verified status — a federation
  // follow-on once cross-instance bundle signing exists.)
  const stmts = [
    env.DB.prepare(
      "INSERT INTO accounts (callsign, verified, verify_method, created_at) VALUES (?, 0, 'migrated', ?)",
    ).bind(cs, now()),
    env.DB.prepare(
      "INSERT OR REPLACE INTO account_events (callsign, action, detail, at) VALUES (?, 'moved', ?, ?)",
    ).bind(cs, `from:${bundle.instance ?? "?"}`, now()),
    // announce the move to the network — the target attests "this callsign now homes here",
    // signed at serve time on the account-move feed so peers can re-point attribution.
    // with the mover's signed assertion as its proof, so mirrors can check the move for themselves
    env.DB.prepare(
      "INSERT INTO account_moves (callsign, from_instance, to_instance, ts, proof_key, proof_sig, proof_at) VALUES (?,?,?,?,?,?,?)",
    ).bind(cs, bundle.instance ?? null, instanceOf(env, req), now(), a.key, a.sig, a.at),
  ];
  for (const k of bundle.keys)
    stmts.push(
      env.DB.prepare(
        "INSERT OR IGNORE INTO callsign_keys (callsign, public_key, label, verified, created_at) VALUES (?,?,?, 0, ?)",
      ).bind(cs, k.publicKey, k.label ?? null, now()),
    );
  await env.DB.batch(stmts);
  return json({ ok: true, callsign: cs, importedKeys: bundle.keys.length, from: bundle.instance ?? null });
}

// ----------------------------------------------------- federation: account-move feed
interface MoveRow {
  seq: number;
  callsign: string;
  from_instance: string | null;
  to_instance: string;
  ts: number;
  proof_key: string | null;
  proof_sig: string | null;
  proof_at: number | null;
}
export const ACCOUNT_MOVE_FEED: FeedServeDef<MoveRow> = {
  type: "account-move",
  selectRows: async (env, since, limit) =>
    (
      await env.DB.prepare(
        "SELECT seq, callsign, from_instance, to_instance, ts, proof_key, proof_sig, proof_at FROM account_moves WHERE seq > ? ORDER BY seq LIMIT ?",
      )
        .bind(since, limit)
        .all<MoveRow>()
    ).results,
  recordOf: (r, instance) => ({
    id: `${instance}:move:${r.seq}`,
    cursor: r.seq,
    data: {
      callsign: r.callsign,
      fromInstance: r.from_instance,
      toInstance: r.to_instance,
      ts: r.ts,
      ...(r.proof_key && r.proof_sig && r.proof_at != null
        ? { proofKey: r.proof_key, proofSig: r.proof_sig, proofAt: r.proof_at }
        : {}),
    },
  }),
};
export const handleFederationAccountMoves = (req: Request, env: Env): Promise<Response> =>
  serveFeed(req, env, ACCOUNT_MOVE_FEED);
