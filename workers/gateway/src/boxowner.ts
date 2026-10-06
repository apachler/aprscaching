// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * boxowner.ts — who owns an ingest box, and what goes with a box when its key, its owner or its call goes.
 *
 * The owner is the account a box transmits for (txgate.ts) and takes remote commands from (box.ts):
 *  - a box enrolled for a callsign belongs to whoever holds that base call now, whoever enrolled it: a sysop
 *    who lets in another ham's box hands it to that ham, and it follows the call when the call changes hands;
 *  - any other enrolled box belongs to the account in `boxes`: the sysop who enrolled it, or the account it was
 *    paired with since;
 *  - a box on the shared secret belongs to the account it was paired with (`boxes`).
 * A revoked key ends the ownership with it: revoking deletes the `boxes` row, and a box whose key is revoked
 * has no owner until it enrols again.
 *
 * The SQL fragment {@link BOX_OWNER_SQL} is the same rule for queries that judge many boxes at once (the
 * attested sites pause while a box's owner is suspended).
 */
import type { Env } from "./env.js";
import type { SqlStatement } from "./runtime.js";
import { baseHolder } from "./auth.js";

/** The owning account of a live box_keys row `k` (alias), in SQL: the enrolled call's holder, else `boxes`. */
export const BOX_OWNER_SQL = `CASE WHEN k.callsign IS NOT NULL
    THEN (SELECT ac.account_id FROM account_callsigns ac WHERE ac.callsign = k.callsign)
    ELSE (SELECT b.account_id FROM boxes b WHERE b.box_id = k.box_id) END`;

/** The account that owns box `boxId`, or null: see the module comment. */
export async function boxOwner(env: Env, boxId: string): Promise<string | null> {
  const key = await env.DB.prepare("SELECT callsign, revoked_at FROM box_keys WHERE box_id = ?")
    .bind(boxId)
    .first<{ callsign: string | null; revoked_at: number | null }>();
  if (key?.revoked_at != null) return null;
  if (key?.callsign) return baseHolder(env, key.callsign);
  const row = await env.DB.prepare("SELECT account_id FROM boxes WHERE box_id = ?")
    .bind(boxId)
    .first<{ account_id: string }>();
  return row?.account_id ?? null;
}

/** Does box `boxId` have a key of its own (live or revoked)? Such a box speaks only through its signature. */
export async function boxHasKey(env: Env, boxId: string): Promise<boolean> {
  return !!(await env.DB.prepare("SELECT 1 AS x FROM box_keys WHERE box_id = ?").bind(boxId).first());
}

/**
 * The statements that forget the boxes `ids` selects (a subquery over `box_id`, with its binds): their trust,
 * their last status, an open pairing, their queued commands and, last, their owner. Their box_keys rows are left
 * to the caller, which revokes or deletes them after these run.
 */
export function forgetBoxes(env: Env, ids: string, binds: unknown[]): SqlStatement[] {
  return [
    ...["box_trusted_sites", "box_status", "box_pairings"].map((t) =>
      env.DB.prepare(`DELETE FROM ${t} WHERE box_id IN (${ids})`).bind(...binds),
    ),
    env.DB.prepare(`DELETE FROM box_commands WHERE status = 'queued' AND box_id IN (${ids})`).bind(...binds),
    env.DB.prepare(`DELETE FROM boxes WHERE box_id IN (${ids})`).bind(...binds),
  ];
}

/** `col` names base call `cs` or an SSID of it. */
const ofCall = (col: string) => `(${col} = ? OR ${col} LIKE ?)`;

/**
 * The statements that take base call `cs` out of every box and trusted site when it leaves its holder (a release
 * or an erasure): a box enrolled for the call is revoked and forgotten, and no site of the call stays trusted,
 * by call or through any box. `by` is recorded as the revoker. The caller drops the attested-sites cache after.
 */
export function releaseBoxCall(env: Env, cs: string, by: string, now: number): SqlStatement[] {
  const enrolledFor = "SELECT box_id FROM box_keys WHERE callsign = ? AND revoked_at IS NULL";
  return [
    ...forgetBoxes(env, enrolledFor, [cs]),
    env.DB.prepare("UPDATE box_keys SET revoked_at = ?, revoked_by = ? WHERE callsign = ? AND revoked_at IS NULL").bind(
      now,
      by,
      cs,
    ),
    env.DB.prepare(`DELETE FROM box_trusted_sites WHERE ${ofCall("site")}`).bind(cs, `${cs}-%`),
    env.DB.prepare(`DELETE FROM trusted_sites WHERE ${ofCall("site")}`).bind(cs, `${cs}-%`),
  ];
}

/**
 * The statements that remove an erased account's boxes: those it owns, those it enrolled for nobody else, those
 * enrolled for one of its `calls`, and every row of theirs. A box it enrolled for another ham's call stays, since
 * that ham owns it; the record of who enrolled it, revoked it or trusted its sites stops naming the account.
 */
export async function eraseAccountBoxes(env: Env, accountId: string, calls: string[]): Promise<SqlStatement[]> {
  const held = calls.map(() => "?").join(",") || "NULL";
  // a box enrolled for a call some other account holds stays with that account
  const rows = await env.DB.prepare(
    `SELECT k.box_id AS id FROM box_keys k
      WHERE k.callsign IN (${held})
         OR ((k.enrolled_by = ? OR k.box_id IN (SELECT box_id FROM boxes WHERE account_id = ?))
             AND NOT (k.callsign IS NOT NULL AND EXISTS (SELECT 1 FROM account_callsigns ac
                       WHERE ac.callsign = k.callsign AND ac.account_id != ?)))
     UNION SELECT b.box_id AS id FROM boxes b
      WHERE b.account_id = ? AND NOT EXISTS (SELECT 1 FROM box_keys k WHERE k.box_id = b.box_id)`,
  )
    .bind(...calls, accountId, accountId, accountId, accountId)
    .all<{ id: string }>();
  const ids = (rows.results ?? []).map((r) => r.id);
  const list = ids.map(() => "?").join(",");
  return [
    ...(ids.length
      ? [
          ...forgetBoxes(env, list, ids),
          env.DB.prepare(`DELETE FROM box_commands WHERE box_id IN (${list})`).bind(...ids),
          env.DB.prepare(`DELETE FROM box_keys WHERE box_id IN (${list})`).bind(...ids),
        ]
      : []),
    env.DB.prepare("UPDATE box_keys SET enrolled_by = 'erased' WHERE enrolled_by = ?").bind(accountId),
    env.DB.prepare("UPDATE box_keys SET revoked_by = 'erased' WHERE revoked_by = ?").bind(accountId),
    env.DB.prepare("UPDATE box_trusted_sites SET trusted_by = 'erased' WHERE trusted_by = ?").bind(accountId),
    env.DB.prepare("UPDATE trusted_sites SET trusted_by = 'erased' WHERE trusted_by = ?").bind(accountId),
    env.DB.prepare("DELETE FROM box_enrollment_codes WHERE created_by = ?").bind(accountId),
  ];
}
