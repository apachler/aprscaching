// SPDX-License-Identifier: AGPL-3.0-or-later
// A seam on the database's search for a fix that contradicts a presence (track.ts outrunBy): the trust reads ask it
// one row at a time, and a test answers it with a fix the verify engine does not take as contradicting, to reach the
// handling of such a row from every caller.
import type { Env } from "@aprscaching/gateway/env";
import type { SqlStatement } from "@aprscaching/gateway/runtime";

/** An APRS-IS fix of `call`, stored and returned: anyone can inject one, so the engine never takes it as contradicting. */
export async function decoyFix(env: Env, call: string, ts: number, lat: number, lon: number): Promise<unknown> {
  return env.DB.prepare(
    `INSERT INTO positions (callsign, ts, lat, lon, heard_via, path, source, transport)
     VALUES (?, ?, ?, ?, 'aprs_is', 'TCPIP*,qAC,T2', 'firehose', 'aprs-is') RETURNING *`,
  )
    .bind(call, ts, lat, lon)
    .first();
}

/** `env` whose search for a contradicting fix answers with `decoy` for its first `times` questions, and truly after. */
export function decoying(env: Env, decoy: unknown, times: number): Env {
  let asked = 0;
  const wrap = (s: SqlStatement, sql: string): SqlStatement => ({
    bind: (...v: unknown[]) => wrap(s.bind(...v), sql),
    run: () => s.run(),
    all: <T>() => s.all<T>(),
    first: async <T>() => {
      if (/NOT IN \(SELECT value FROM json_each/.test(sql) && asked++ < times) return decoy as T;
      return s.first<T>();
    },
  });
  return { ...env, DB: { prepare: (sql) => wrap(env.DB.prepare(sql), sql), batch: (st) => env.DB.batch(st) } };
}
