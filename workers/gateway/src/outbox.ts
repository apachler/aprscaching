// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Env } from "./env.js";
import { json } from "./app.js";

/** ingest box pulls queued APRS-IS messages to publish. Auth via x-ingest-secret. */
export async function outboxPending(req: Request, env: Env): Promise<Response> {
  if (req.headers.get("x-ingest-secret") !== env.INGEST_SECRET) return new Response("unauthorized", { status: 401 });
  const rows = await env.DB.prepare("SELECT id, src_call, tocall, kind, payload, target FROM aprs_outbox WHERE status='queued' ORDER BY ts LIMIT 50").all();
  return json({ items: rows.results });
}

export async function outboxAck(req: Request, env: Env): Promise<Response> {
  if (req.headers.get("x-ingest-secret") !== env.INGEST_SECRET) return new Response("unauthorized", { status: 401 });
  const { ids } = (await req.json()) as { ids: number[] };
  if (ids?.length) {
    const now = Math.floor(Date.now() / 1000);
    await env.DB.batch(ids.map((id) => env.DB.prepare("UPDATE aprs_outbox SET status='sent', sent_at=? WHERE id=?").bind(now, id)));
  }
  return json({ ok: true });
}
