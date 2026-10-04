// SPDX-License-Identifier: AGPL-3.0-or-later
import { nowS } from "./util/time.js";
import { ingestSecretOk } from "./auth.js";
import type { Env } from "./env.js";
import { OUTBOX_QUEUED_TTL_S } from "./retention.js";
import { json } from "./app.js";

/** ingest box pulls queued APRS-IS messages to publish. Auth via x-ingest-secret. */
export async function outboxPending(req: Request, env: Env): Promise<Response> {
  if (!ingestSecretOk(req, env)) return new Response("unauthorized", { status: 401 });
  const rows = await env.DB.prepare(
    "SELECT id, src_call, tocall, kind, payload, target FROM aprs_outbox WHERE status='queued' AND ts >= ? ORDER BY ts LIMIT 50",
  )
    .bind(nowS() - OUTBOX_QUEUED_TTL_S) // older items are stale on the air; the nightly prune deletes them
    .all();
  return json({ items: rows.results });
}

export async function outboxAck(req: Request, env: Env): Promise<Response> {
  if (!ingestSecretOk(req, env)) return new Response("unauthorized", { status: 401 });
  const b = (await req.json().catch(() => null)) as { ids?: unknown } | null;
  if (!b) return json({ error: "a JSON body {ids} is required" }, { status: 400 });
  const ids: unknown[] = b.ids === undefined ? [] : Array.isArray(b.ids) ? b.ids : [null];
  if (!ids.every((id) => Number.isInteger(id)))
    return json({ error: "ids must be a list of message ids" }, { status: 400 });
  if (ids.length) {
    const now = nowS();
    await env.DB.batch(
      ids.map((id) => env.DB.prepare("UPDATE aprs_outbox SET status='sent', sent_at=? WHERE id=?").bind(now, id)),
    );
  }
  return json({ ok: true });
}
