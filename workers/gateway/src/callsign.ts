import type { Env } from "./env.js";
import { json } from "./app.js";

/** Start an APRS message-challenge: queue a one-time code to be sent to the callsign over APRS. */
export async function startAprsChallenge(req: Request, env: Env): Promise<Response> {
  const { callsign } = (await req.json()) as { callsign: string };
  const cs = callsign.toUpperCase();
  const code = String(Math.floor(100000 + Math.random() * 900000));
  await env.DB.prepare(
    `INSERT INTO callsign_verifications (callsign, method, status, challenge)
     VALUES (?, 'aprs_msg', 'pending', ?)
     ON CONFLICT(callsign) DO UPDATE SET method='aprs_msg', status='pending', challenge=excluded.challenge`,
  ).bind(cs, code).run();
  // queue an APRS message to the user's callsign via the outbox (ingest delivers it)
  await env.DB.prepare(
    `INSERT INTO aprs_outbox (ts, src_call, tocall, kind, payload)
     VALUES (?, 'APRSCG', 'APZACG', 'message', ?)`,
  ).bind(Math.floor(Date.now() / 1000), `:${cs.padEnd(9)}:aprscaching code ${code}`).run();
  return json({ sent: true });
}

export async function confirmAprsChallenge(req: Request, env: Env): Promise<Response> {
  const { callsign, code } = (await req.json()) as { callsign: string; code: string };
  const cs = callsign.toUpperCase();
  const row = await env.DB.prepare("SELECT challenge FROM callsign_verifications WHERE callsign = ?").bind(cs).first<{ challenge: string }>();
  if (!row || row.challenge !== code) return json({ verified: false }, { status: 400 });
  const now = Math.floor(Date.now() / 1000);
  await env.DB.batch([
    env.DB.prepare("UPDATE callsign_verifications SET status='verified', verified_at=? WHERE callsign=?").bind(now, cs),
    env.DB.prepare("UPDATE accounts SET verified=1, verify_method='aprs_msg', verified_at=? WHERE callsign=?").bind(now, cs),
    // mirror onto the held base call (account_callsigns) so a verified call keeps its status when
    // the account later switches its active call to (or away from) this one.
    env.DB.prepare("UPDATE account_callsigns SET verified=1, method='aprs_msg', verified_at=? WHERE callsign=?").bind(now, cs),
  ]);
  return json({ verified: true });
}

export async function isCallsignVerified(env: Env, callsign: string): Promise<boolean> {
  const r = await env.DB.prepare("SELECT status FROM callsign_verifications WHERE callsign = ?").bind(callsign).first<{ status: string }>();
  return r?.status === "verified";
}

/** GET /verify/aprs/status?callsign= — control-verification state of a callsign's BASE call. */
export async function aprsVerifyStatus(req: Request, env: Env): Promise<Response> {
  const cs = (new URL(req.url).searchParams.get("callsign") ?? "").toUpperCase().split("-")[0]!;
  if (cs.length < 3) return json({ verified: false });
  return json({ verified: await isCallsignVerified(env, cs) });
}
