// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * radiolog.ts — logging finds by radio message.
 *
 * A text message addressed to the instance's service call (`BBS_CALL`, default `APRSCG`) is a command:
 *
 *   FOUND <code> [text]   log a find          DNF <code> [text]   log a did-not-find
 *   NOTE <code> <text>    log a note          HELP                the command syntax
 *
 * Every transport that carries text messages hands them to the ingest as APRS message packets, so one
 * handler serves APRS over RF, APRS-IS and MeshCom alike. The transport decides two things only:
 *
 *  - Whether the message is accepted as the sender's own. Anyone can inject a message with any source
 *    call into APRS-IS, so a command logs immediately only when it was heard at an attested RF site
 *    (the same provenance rule as Tier A) or came in a batch signed by the sender's registered device
 *    key. Anything else is recorded as `pending` until the signed-in player confirms it in the app.
 *  - Where the answer goes. Acks and replies travel back the way the message came: a message the ingest
 *    box heard on its own radio is answered by that box — on RF as third-party traffic from the service
 *    call under the box's licensed call, or through the MeshCom node that heard it — so off-grid works
 *    without APRS-IS. When that box is not polling or cannot transmit, APRS answers go through the
 *    APRS-IS outbox; a MeshCom message then gets no answer.
 *
 * The log belongs to the account that holds the sender's control-verified base call — never to the bare
 * call string. A find is scored by the normal verification engine at the time the message was sent; a
 * radio message carries no in-app device reading, so it reaches Tier A or C, never B.
 */
import type { Env } from "./env.js";
import { json } from "./app.js";
import { sessionAccountId } from "./auth.js";
import { provenanceOf, parseAttestedSites } from "./provenance.js";
import { scoreFind, commitFind, commitPlainLog, type FindScore } from "./caches.js";
import { freshBoxCaps, enqueueSystemBoxCommand } from "./box.js";
import type { CacheRow } from "./verify.js";

/** Commands a sender may run per rolling hour; beyond that they are acked and rejected. */
export const RADIO_COMMANDS_PER_HOUR = 10;
/** A pending command the player has not confirmed expires after this long. */
export const RADIO_PENDING_TTL_SEC = 7 * 24 * 3600;
/** At most one text reply per destination in this window. */
export const RADIO_REPLY_INTERVAL_SEC = 10 * 60;
/** A retry of the same message (same number, or same text when unnumbered) within this window runs once. */
const DUPLICATE_WINDOW_SEC = 30 * 60;
/** APRS message text limit. */
const APRS_TEXT_MAX = 67;

export const HELP_TEXT = "FOUND <code> [log] | DNF <code> [log] | NOTE <code> <text>";

export type RadioCommand =
  | { command: "found" | "dnf"; code: string; body?: string }
  | { command: "note"; code: string; body: string }
  | { command: "help" };

/** The service call radio commands are addressed to — the identity BBS mail and verification codes use. */
export const serviceCall = (env: Env): string => (env.BBS_CALL ?? "APRSCG").toUpperCase();

const baseCall = (c: string) => c.replace(/\*$/, "").split("-")[0]!.toUpperCase();

/** `ac1234`, `AC-1234`, `ac-1234` → `AC-1234`; anything that isn't letters followed by digits → null. */
export function normalizeCacheCode(raw: string): string | null {
  const m = /^([A-Za-z]{1,4})-?(\d{1,8})$/.exec(raw.trim());
  return m ? `${m[1]!.toUpperCase()}-${m[2]}` : null;
}

/** Parse a command message. Pure: the whole grammar lives here. */
export function parseRadioCommand(text: string): RadioCommand | { error: string } {
  const t = text.trim();
  if (!t) return { error: "empty message — send HELP" };
  const [head = "", ...rest] = t.split(/\s+/);
  const word = head.toUpperCase();
  if (word === "HELP" || word === "?") return { command: "help" };
  if (word !== "FOUND" && word !== "DNF" && word !== "NOTE") return { error: "unknown command — send HELP" };
  const code = rest[0] ? normalizeCacheCode(rest[0]) : null;
  if (!code) return { error: `${word} needs a cache code, e.g. ${word} AC-1234` };
  const body = rest.slice(1).join(" ").trim();
  if (word === "NOTE") return body ? { command: "note", code, body } : { error: "NOTE needs a text" };
  return { command: word === "FOUND" ? "found" : "dnf", code, ...(body ? { body } : {}) };
}

/** Split an APRS message text into its body and message number, tolerating the reply-ack form `{MM}AA`. */
export function splitMessageNumber(text: string, msgNo?: string): { text: string; msgNo?: string } {
  const m = /\{([A-Za-z0-9]{1,5})(\}[A-Za-z0-9]{0,2})?$/.exec(text);
  if (m) return { text: text.slice(0, m.index), msgNo: m[1] };
  const n = msgNo?.split("}")[0]?.trim();
  return { text, ...(n ? { msgNo: n } : {}) };
}

/** One command message as the ingest saw it. */
export interface RadioMessage {
  src: string;
  text: string;
  msgNo?: string;
  ts: number;
  port: string;
  heardVia: string;
  igateCall?: string | null;
  path: string[];
  /** The batch was signed by the sender's own registered device key. */
  signed: boolean;
  /** The ingest box, and the station on it, that received the message over its own radio (routing only). */
  box?: string;
  rxCall?: string;
}

/** Is this message accepted as the sender's own without a confirmation in the app? */
export function isTrustedMessage(m: RadioMessage, attestedSites: Set<string>): boolean {
  if (m.signed) return true;
  return provenanceOf({ heard_via: m.heardVia, igate_call: m.igateCall ?? null, path: m.path.join(",") }, attestedSites)
    .firstPartyAttested;
}

const now = () => Math.floor(Date.now() / 1000);

type CacheForLog = CacheRow & { id: number; code: string; title: string };

interface CommandRow {
  id: number;
  from_call: string;
  account_id: string | null;
  command: string;
  cache_id: number | null;
  cache_code: string | null;
  body: string | null;
  status: string;
  score: string | null;
  sent_at: number;
}

/** Queue an APRS message from the service call to `to` through the outbox. */
async function queueAprs(env: Env, to: string, text: string): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO aprs_outbox (ts, src_call, tocall, kind, payload) VALUES (?, ?, 'APZACG', 'message', ?)",
  )
    .bind(now(), serviceCall(env), `:${to.toUpperCase().padEnd(9)}:${text.slice(0, APRS_TEXT_MAX)}`)
    .run();
}

const repliesEnabled = (env: Env) => env.RADIO_REPLIES === "1";

/** Ports on which the ingest box itself received the frame over a radio it can also transmit on. */
const RF_PORTS = new Set(["kiss-tnc"]);

/**
 * Send `text` to the sender the way the message came: through the box that heard it when that box is
 * polling and can transmit on the same radio, else — for APRS — through the APRS-IS outbox.
 */
async function answer(env: Env, m: RadioMessage, text: string): Promise<void> {
  const caps = m.box ? await freshBoxCaps(env, m.box) : null;
  if (m.port === "meshcom") {
    const node = m.rxCall?.toUpperCase();
    if (caps?.tx && node && caps.meshcom.includes(node))
      await enqueueSystemBoxCommand(env, m.box!, "meshcom_msg", { node, dst: m.src.toUpperCase(), text });
    return;
  }
  if (caps?.tx && caps.rf && RF_PORTS.has(m.port))
    return enqueueSystemBoxCommand(env, m.box!, "aprs_msg", {
      from: serviceCall(env),
      to: m.src.toUpperCase(),
      text: text.slice(0, APRS_TEXT_MAX),
    });
  await queueAprs(env, m.src, text);
}

/**
 * Acknowledge a numbered message so the sender's radio stops retrying. MeshCom offers an external client
 * no ack frame; its receive path recognises a text message `SENDER   :ack<nnn>` as the acknowledgement of
 * message nnn and matches it by number alone, so the node that heard the message can ack it that way.
 */
export function ackText(port: string, src: string, msgNo: string): string {
  return port === "meshcom" ? `${src.toUpperCase().padEnd(9)}:ack${msgNo}` : `ack${msgNo}`;
}

async function ack(env: Env, m: RadioMessage): Promise<void> {
  if (m.msgNo) await answer(env, m, ackText(m.port, m.src, m.msgNo));
}

/**
 * Send a fixed text reply when allowed: operator opt-in (`RADIO_REPLIES=1`) unless the sender asked for
 * HELP, and at most one reply per destination per {@link RADIO_REPLY_INTERVAL_SEC}.
 */
async function reply(env: Env, m: RadioMessage, rowId: number, text: string, asked = false): Promise<void> {
  if (!(asked || repliesEnabled(env))) return;
  const recent = await env.DB.prepare(
    "SELECT 1 AS x FROM radio_commands WHERE from_call = ? AND replied_at >= ? LIMIT 1",
  )
    .bind(m.src.toUpperCase(), now() - RADIO_REPLY_INTERVAL_SEC)
    .first();
  if (recent) return;
  await answer(env, m, text);
  await env.DB.prepare("UPDATE radio_commands SET replied_at = ? WHERE id = ?").bind(now(), rowId).run();
}

async function insertRow(
  env: Env,
  m: RadioMessage,
  f: {
    accountId?: string | null;
    command: string;
    cache?: CacheForLog | null;
    code?: string | null;
    body?: string | null;
    trusted: boolean;
    status: string;
    reason?: string | null;
    score?: FindScore | null;
    logId?: number | null;
  },
): Promise<number> {
  const r = await env.DB.prepare(
    `INSERT INTO radio_commands (from_call, account_id, command, cache_id, cache_code, body, raw_text, msg_no, port,
       heard_via, igate_call, trusted, status, reason, score, log_id, sent_at, created_at, decided_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  )
    .bind(
      m.src.toUpperCase(),
      f.accountId ?? null,
      f.command,
      f.cache?.id ?? null,
      f.cache?.code ?? f.code ?? null,
      f.body ?? null,
      m.text,
      m.msgNo ?? null,
      m.port,
      m.heardVia,
      m.igateCall ?? null,
      f.trusted ? 1 : 0,
      f.status,
      f.reason ?? null,
      f.score ? JSON.stringify(f.score) : null,
      f.logId ?? null,
      m.ts,
      now(),
      f.status === "pending" ? null : now(),
    )
    .run();
  return Number(r.meta?.last_row_id);
}

/** The reply text for a logged find. */
const foundText = (code: string, s: FindScore) =>
  s.result.verified
    ? `${code} found, logged Tier ${s.result.tier}`
    : `${code} found, logged unverified (Tier ${s.result.tier})`;

/** Commit a command's log. Returns the new log id, or `duplicate` when the player already found the cache. */
async function commitCommand(
  env: Env,
  row: Pick<CommandRow, "from_call" | "command" | "body" | "sent_at">,
  cache: CacheForLog,
  score: FindScore | null,
): Promise<{ logId?: number; duplicate?: boolean }> {
  if (row.command === "found") {
    const c = await commitFind(env, cache, row.from_call, row.sent_at, row.body, score!);
    return c.duplicate ? { duplicate: true } : { logId: c.logId };
  }
  const logType = row.command === "dnf" ? "dnf" : "note";
  return { logId: await commitPlainLog(env, cache.id, row.from_call, row.sent_at, logType, row.body) };
}

async function loadCache(env: Env, id: number): Promise<CacheForLog | null> {
  return env.DB.prepare("SELECT * FROM caches WHERE id = ?").bind(id).first<CacheForLog>();
}

/** Has this sender already logged a found for the cache (under any SSID of the same call string)? */
async function alreadyFound(env: Env, cacheId: number, loggerCall: string): Promise<boolean> {
  const r = await env.DB.prepare(
    "SELECT 1 AS x FROM cache_logs WHERE cache_id = ? AND logger_call = ? AND log_type = 'found' LIMIT 1",
  )
    .bind(cacheId, loggerCall)
    .first();
  return !!r;
}

/**
 * Handle one command message. Every outcome is recorded in `radio_commands`; a numbered APRS message is
 * always acknowledged so the sender's radio stops retrying.
 */
export async function handleRadioMessage(env: Env, m: RadioMessage): Promise<void> {
  const src = m.src.toUpperCase();
  if (src === serviceCall(env)) return; // never answer ourselves

  // A retry of a message already handled: re-ack only. A copy heard at an attested site upgrades a
  // pending command to logged.
  const trusted = isTrustedMessage(m, parseAttestedSites(env.FIRST_PARTY_SITES));
  const prior = await env.DB.prepare(
    `SELECT * FROM radio_commands WHERE from_call = ? AND sent_at >= ?
       AND ((? IS NOT NULL AND msg_no = ?) OR (? IS NULL AND msg_no IS NULL AND raw_text = ?))
     ORDER BY id DESC LIMIT 1`,
  )
    .bind(src, m.ts - DUPLICATE_WINDOW_SEC, m.msgNo ?? null, m.msgNo ?? null, m.msgNo ?? null, m.text)
    .first<CommandRow>();
  if (prior) {
    await ack(env, m);
    if (prior.status === "pending" && trusted) await confirmRow(env, prior, true);
    return;
  }

  const recent = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM radio_commands WHERE from_call = ? AND created_at >= ?",
  )
    .bind(src, now() - 3600)
    .first<{ n: number }>();
  if ((recent?.n ?? 0) >= RADIO_COMMANDS_PER_HOUR) {
    await insertRow(env, m, { command: "invalid", trusted, status: "rejected", reason: "rate limited" });
    await ack(env, m);
    return; // no reply: a sender over the limit gets nothing but the protocol ack
  }

  const parsed = parseRadioCommand(m.text);
  if ("error" in parsed) {
    const id = await insertRow(env, m, { command: "invalid", trusted, status: "rejected", reason: parsed.error });
    await ack(env, m);
    await reply(env, m, id, parsed.error);
    return;
  }
  if (parsed.command === "help") {
    const id = await insertRow(env, m, { command: "help", trusted, status: "help" });
    await ack(env, m);
    await reply(env, m, id, HELP_TEXT, true);
    return;
  }

  const reject = async (reason: string, extra: { accountId?: string | null; cache?: CacheForLog | null } = {}) => {
    const id = await insertRow(env, m, {
      command: parsed.command,
      code: parsed.code,
      body: parsed.body ?? null,
      trusted,
      status: "rejected",
      reason,
      ...extra,
    });
    await ack(env, m);
    await reply(env, m, id, reason);
  };

  const acct = await env.DB.prepare("SELECT account_id FROM account_callsigns WHERE callsign = ? AND verified = 1")
    .bind(baseCall(src))
    .first<{ account_id: string }>();
  if (!acct) return reject(`${baseCall(src)} is not a verified callsign here - verify it in the app`);

  const cache = await env.DB.prepare("SELECT * FROM caches WHERE code = ?").bind(parsed.code).first<CacheForLog>();
  if (!cache) return reject(`unknown cache ${parsed.code}`, { accountId: acct.account_id });
  if (parsed.command === "found" && (await alreadyFound(env, cache.id, src)))
    return reject(`${cache.code} is already logged as found`, { accountId: acct.account_id, cache });

  const score = parsed.command === "found" ? await scoreFind(env, cache, src, m.ts) : null;
  const base = {
    accountId: acct.account_id,
    command: parsed.command,
    cache,
    body: parsed.body ?? null,
    trusted,
    score,
  };

  if (!trusted) {
    const id = await insertRow(env, m, { ...base, status: "pending" });
    await ack(env, m);
    await reply(env, m, id, `${cache.code} received - confirm it in the app`);
    return;
  }

  const c = await commitCommand(
    env,
    { from_call: src, command: parsed.command, body: parsed.body ?? null, sent_at: m.ts },
    cache,
    score,
  );
  if (c.duplicate) return reject(`${cache.code} is already logged as found`, { accountId: acct.account_id, cache });
  const id = await insertRow(env, m, { ...base, status: "logged", logId: c.logId ?? null });
  await ack(env, m);
  await reply(
    env,
    m,
    id,
    parsed.command === "found" ? foundText(cache.code, score!) : `${cache.code} ${parsed.command.toUpperCase()} logged`,
  );
}

/** Turn a pending command into a log. `onAir` marks a confirmation by a later attested copy of the message. */
async function confirmRow(
  env: Env,
  row: CommandRow,
  onAir: boolean,
): Promise<{ ok: boolean; reason?: string; logId?: number }> {
  const done = async (status: string, reason: string | null, logId: number | null) =>
    env.DB.prepare(
      "UPDATE radio_commands SET status = ?, reason = ?, log_id = ?, decided_at = ?, trusted = MAX(trusted, ?) WHERE id = ? AND status = 'pending'",
    )
      .bind(status, reason, logId, now(), onAir ? 1 : 0, row.id)
      .run();
  const cache = row.cache_id != null ? await loadCache(env, row.cache_id) : null;
  if (!cache) {
    await done("rejected", "the cache no longer exists", null);
    return { ok: false, reason: "the cache no longer exists" };
  }
  const score = row.score ? (JSON.parse(row.score) as FindScore) : null;
  const c = await commitCommand(env, row, cache, score);
  if (c.duplicate) {
    await done("rejected", `${cache.code} is already logged as found`, null);
    return { ok: false, reason: `${cache.code} is already logged as found` };
  }
  await done("logged", null, c.logId ?? null);
  return { ok: true, logId: c.logId };
}

/** Expire pending commands nobody confirmed. Called from the nightly job. */
export async function expireRadioCommands(env: Env): Promise<void> {
  await env.DB.prepare(
    "UPDATE radio_commands SET status = 'expired', decided_at = ? WHERE status = 'pending' AND sent_at < ?",
  )
    .bind(now(), now() - RADIO_PENDING_TTL_SEC)
    .run();
}

// ---------------------------------------------------------------- API for the signed-in player

/** GET /api/radio/commands — the signed-in account's recent radio commands and the address to send to. */
export async function handleRadioCommandsList(req: Request, env: Env): Promise<Response> {
  const me = await sessionAccountId(req, env);
  if (!me) return json({ error: "sign in first" }, { status: 401 });
  const rows = (
    await env.DB.prepare(
      `SELECT id, from_call AS fromCall, command, cache_code AS cacheCode, body, trusted, status, reason, score,
              sent_at AS sentAt, decided_at AS decidedAt
         FROM radio_commands WHERE account_id = ? ORDER BY sent_at DESC LIMIT 50`,
    )
      .bind(me.accountId)
      .all<{ score: string | null; trusted: number }>()
  ).results;
  return json({
    serviceCall: serviceCall(env),
    commands: rows.map(({ score, trusted, ...r }) => {
      const s = score ? (JSON.parse(score) as FindScore) : null;
      return { ...r, trusted: trusted === 1, ...(s ? { tier: s.result.tier, verified: s.result.verified } : {}) };
    }),
  });
}

/** The player's decision on a pending command. Another account's command reads as absent. */
export async function decideRadioCommand(
  env: Env,
  accountId: string,
  id: number,
  decision: "confirm" | "discard",
): Promise<{ status: number; body: Record<string, unknown> }> {
  const row = await env.DB.prepare("SELECT * FROM radio_commands WHERE id = ?").bind(id).first<CommandRow>();
  if (!row || row.account_id !== accountId) return { status: 404, body: { error: "no such command" } };
  if (row.status !== "pending") return { status: 409, body: { error: `already ${row.status}` } };
  if (decision === "discard") {
    await env.DB.prepare(
      "UPDATE radio_commands SET status = 'discarded', decided_at = ? WHERE id = ? AND status = 'pending'",
    )
      .bind(now(), id)
      .run();
    return { status: 200, body: { ok: true, status: "discarded" } };
  }
  const r = await confirmRow(env, row, false);
  return r.ok
    ? { status: 200, body: { ok: true, status: "logged", logId: r.logId } }
    : { status: 409, body: { ok: false, status: "rejected", error: r.reason } };
}

/** POST /api/radio/commands/:id/confirm | /discard — the signed-in player decides on a pending command. */
export async function handleRadioCommandDecision(
  req: Request,
  env: Env,
  id: number,
  decision: "confirm" | "discard",
): Promise<Response> {
  const me = await sessionAccountId(req, env);
  if (!me) return json({ error: "sign in first" }, { status: 401 });
  const r = await decideRadioCommand(env, me.accountId, id, decision);
  return json(r.body, { status: r.status });
}
