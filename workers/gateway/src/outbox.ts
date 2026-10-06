// SPDX-License-Identifier: AGPL-3.0-or-later
import { nowS } from "./util/time.js";
import { ingestOrServiceBoxOk } from "./auth.js";
import type { Env } from "./env.js";
import { OUTBOX_QUEUED_TTL_S } from "./retention.js";
import { json } from "./http.js";
import { serviceCall } from "./servicecall.js";
import { callSuspended } from "./moderation.js";

type OutboxRow = { id: number; src_call: string; tocall: string; kind: string; payload: string; target: string };

/** A row the box can write as one APRS-IS line: no field holds a CR, LF or NUL. */
export const outboxRowOk = (r: Pick<OutboxRow, "src_call" | "tocall" | "payload">): boolean =>
  [r.src_call, r.tocall, r.payload].every((v) => typeof v === "string" && !/[\r\n\0]/.test(v));

/** The sender a Mailbox message names in its text (`:ADDRESSEE:de <call>: …`), or null for any other payload. */
const mailboxSender = (payload: string): string | null =>
  /^:.{9}:de ([A-Z0-9]{1,6}(?:-\d{1,2})?):/i.exec(payload)?.[1]?.toUpperCase() ?? null;

/**
 * The ingest box pulls queued APRS-IS messages to publish: the shared secret, or a box that runs this instance's services.
 * A row that is not `outboxRowOk` is never served: it is marked failed, since no retry can make it one line.
 */
export async function outboxPending(req: Request, env: Env): Promise<Response> {
  if (!ingestOrServiceBoxOk(req, env)) return new Response("unauthorized", { status: 401 });
  const rows = await env.DB.prepare(
    "SELECT id, src_call, tocall, kind, payload, target FROM aprs_outbox WHERE status='queued' AND ts >= ? ORDER BY ts LIMIT 50",
  )
    .bind(nowS() - OUTBOX_QUEUED_TTL_S) // older items are stale on the air; the nightly prune deletes them
    .all<OutboxRow>();
  const all = rows.results ?? [];
  // a row of a suspended call, or a Mailbox message the service call carries for one, never goes out
  const service = serviceCall(env);
  const suspended = new Map<string, boolean>();
  const isSuspended = async (call: string) => {
    if (!suspended.has(call)) suspended.set(call, await callSuspended(env, call));
    return suspended.get(call)!;
  };
  const held: OutboxRow[] = [];
  for (const r of all) {
    const src = r.src_call.toUpperCase();
    const sender = src === service ? mailboxSender(r.payload) : src;
    if (sender && (await isSuspended(sender))) held.push(r);
  }
  const live = all.filter((r) => !held.includes(r));
  const items = live.filter(outboxRowOk);
  const bad = live.filter((r) => !outboxRowOk(r));
  const settle = [
    ...bad.map((r) => env.DB.prepare("UPDATE aprs_outbox SET status='failed' WHERE id=?").bind(r.id)),
    ...held.map((r) => env.DB.prepare("DELETE FROM aprs_outbox WHERE id=? AND status='queued'").bind(r.id)),
  ];
  if (settle.length) await env.DB.batch(settle);
  return json({ items });
}

/**
 * Delete the queued APRS-IS traffic of these base calls: what they send under any SSID, and the Mailbox
 * messages the service call carries for them (`de <call>: …`). Nothing a suspended, erased or released holder
 * left in the queue goes on the air after it. Sent rows stay, since they already went out.
 */
export async function dropQueuedFor(env: Env, calls: string[]): Promise<void> {
  const service = serviceCall(env);
  const bases = [...new Set(calls.map((c) => c.trim().toUpperCase()).filter(Boolean))];
  if (!bases.length) return;
  // an APRS message payload is `:ADDRESSEE:text`, so its text starts at the twelfth character
  await env.DB.batch(
    bases.map((c) =>
      env.DB.prepare(
        `DELETE FROM aprs_outbox WHERE status='queued' AND (
           upper(src_call) = ? OR upper(src_call) LIKE ? OR
           (upper(src_call) = ? AND kind = 'message' AND (substr(payload, 12) LIKE ? OR substr(payload, 12) LIKE ?)))`,
      ).bind(c, `${c}-%`, service, `de ${c}:%`, `de ${c}-%`),
    ),
  );
}

export async function outboxAck(req: Request, env: Env): Promise<Response> {
  if (!ingestOrServiceBoxOk(req, env)) return new Response("unauthorized", { status: 401 });
  const b = (await req.json().catch(() => null)) as { ids?: unknown } | null;
  if (!b) return json({ error: "a JSON body {ids} is required" }, { status: 400 });
  const ids: unknown[] = b.ids === undefined ? [] : Array.isArray(b.ids) ? b.ids : [null];
  if (!ids.every((id) => Number.isInteger(id)))
    return json({ error: "ids must be a list of message ids" }, { status: 400 });
  if (ids.length) {
    const now = nowS();
    // a message an operator sent through the instance shows as sent in their conversation from here on
    await env.DB.batch(
      ids.flatMap((id) => [
        env.DB.prepare("UPDATE aprs_outbox SET status='sent', sent_at=? WHERE id=?").bind(now, id),
        env.DB.prepare("UPDATE messages SET sent_at=? WHERE outbox_id=? AND sent_at IS NULL").bind(now, id),
      ]),
    );
  }
  return json({ ok: true });
}
