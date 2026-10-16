// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * delivery.ts — what the sender of a numbered APRS message reports of its repeats: the ingest box for a message
 * its radio or its APRS-IS uplink sent, the browser for one its radio sent. The sender repeats the message until
 * the station acks or rejects it, or its last try goes unanswered (`MessageRetrier` in @aprscaching/aprs), then
 * reports how often it sent it and how it ended. The Messages list shows both.
 */
import type { Env } from "./env.js";
import type { SqlStatement } from "./runtime.js";
import type { RetryOutcome } from "@aprscaching/aprs";

const OUTCOMES = new Set<RetryOutcome>(["acked", "rejected", "expired", "cancelled"]);

export interface DeliveryReport {
  tries: number;
  outcome: RetryOutcome;
}

/** A delivery report from a request body, or null when it is not one: 1–99 tries and a known outcome. */
export function parseDelivery(v: unknown): DeliveryReport | null {
  const d = v as { tries?: unknown; outcome?: unknown } | null;
  if (!d || typeof d !== "object") return null;
  const tries = d.tries;
  if (typeof tries !== "number" || !Number.isInteger(tries) || tries < 1 || tries > 99) return null;
  if (typeof d.outcome !== "string" || !OUTCOMES.has(d.outcome as RetryOutcome)) return null;
  return { tries, outcome: d.outcome as RetryOutcome };
}

/**
 * The statement that records a report on the sent messages `where` selects. An ack the sender heard marks the
 * message acknowledged even when the instance never heard that ack itself; a reject or an unanswered last try
 * says why the sender stopped.
 */
export function deliveryStatement(
  env: Env,
  where: { sql: string; binds: (string | number)[] },
  d: DeliveryReport,
  now: number,
): SqlStatement {
  return env.DB.prepare(
    `UPDATE messages SET tries = ?,
       acked_at = CASE WHEN ? = 'acked' THEN COALESCE(acked_at, ?) ELSE acked_at END,
       gave_up = CASE WHEN ? = 'acked' THEN NULL ELSE ? END
     WHERE direction = 'tx' AND ${where.sql}`,
  ).bind(d.tries, d.outcome, now, d.outcome, d.outcome, ...where.binds);
}
