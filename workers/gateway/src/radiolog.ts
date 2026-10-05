// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * radiolog.ts — logging finds by radio message.
 *
 * A text message addressed to the instance's service call (servicecall.ts) is a command:
 *
 *   FOUND <code> [text]   log a find          DNF <code> [text]   log a did-not-find
 *   NOTE <code> <text>    log a note          HELP                the command syntax
 *   MAIL <call> <text>    leave a Mailbox message (mailbox.ts)
 *   NEAR ON | NEAR OFF    switch the "you're near" radio message (nearradio.ts)
 *   VERIFY <code>         complete the sender's callsign control-verification (callsign.ts)
 *
 * Every transport that carries text messages hands them to the ingest as APRS message packets, so one
 * handler serves APRS over RF, APRS-IS and MeshCom alike. The transport decides two things only:
 *
 *  - Whether the message is accepted as the sender's own. Anyone can inject a message with any source
 *    call — and any path, a forged `qAR` included — into APRS-IS, so a command logs immediately only
 *    when the ingest box heard it on its own radio at an attested site (the same provenance rule as
 *    Tier A) or it came in a batch signed by the sender's registered device key. Anything else, and
 *    everything that arrived over APRS-IS, is recorded as `pending` until the signed-in player confirms
 *    it in the app.
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
import { nowS } from "./util/time.js";
import type { Env } from "./env.js";
import { json } from "./app.js";
import { sessionIdentity, baseHolder } from "./auth.js";
import { provenanceOf, transportForPort } from "./provenance.js";
import { attestation, sitesFor } from "./attestedsites.js";
import { parseVerifyMessage, completeRfChallenge, isCallsignVerified } from "./callsign.js";
import { scoreFind, commitFind, commitPlainLog, applyLogEffects, type FindScore } from "./caches.js";
import { freshBoxCaps, enqueueSystemBoxCommand } from "./box.js";
import { rateLimitedDurable } from "./corroborate_privacy.js";
import type { CacheRow } from "./verify.js";
import { baseCall, encodeAprsMessage } from "@aprscaching/aprs";
import { alreadyFound, logRefusal } from "./findrules.js";
import { serviceCall } from "./servicecall.js";
import { leaveMail } from "./mailbox.js";
import { setNearRadio } from "./nearradio.js";
import type { Transport } from "@aprscaching/shared";

/**
 * Commands one person (a base call, whatever SSID) may run per hour. Beyond that a message is dropped
 * unrecorded and unanswered, so a flood neither grows `radio_commands` nor keys a transmitter.
 */
export const RADIO_COMMANDS_PER_HOUR = 10;
/** Acks and replies the service queues per hour across all senders — the ceiling on what a flood makes it send. */
export const RADIO_ANSWERS_PER_HOUR = 200;
/** Decided commands (logged, rejected, discarded, expired, help) are purged this long after the decision. */
const RADIO_COMMAND_RETENTION_SEC = 30 * 24 * 3600;
/** A pending command the player has not confirmed expires after this long. */
const RADIO_PENDING_TTL_SEC = 7 * 24 * 3600;
/** At most one text reply per destination in this window. */
const RADIO_REPLY_INTERVAL_SEC = 10 * 60;
/** A retry of the same message (same number and text, or same text when unnumbered) within this window runs once. */
const DUPLICATE_WINDOW_SEC = 30 * 60;
/** APRS message text limit. */
const APRS_TEXT_MAX = 67;

export const HELP_TEXT = "FOUND/DNF/NOTE <code> [text]; MAIL <call> <text>; NEAR ON/OFF";

type RadioCommand =
  | { command: "found" | "dnf"; code: string; body?: string }
  | { command: "note"; code: string; body: string }
  | { command: "mail"; to: string; body: string }
  | { command: "near"; on: boolean }
  | { command: "help" };

/**
 * `ac1234`, `AC-1234`, `ac-1234` → `AC-1234`. A heritage reference keeps its own form, upper-cased: a SOTA
 * summit `oe/st-001` → `OE/ST-001`. Anything else (spaces, other punctuation, a bare number) → null.
 */
export function normalizeCacheCode(raw: string): string | null {
  const t = raw.trim();
  const m = /^([A-Za-z]{1,4})-?(\d{1,8})$/.exec(t);
  if (m) return `${m[1]!.toUpperCase()}-${m[2]}`;
  return t.length <= 20 && /^[A-Za-z0-9]+(?:[/-][A-Za-z0-9]+){1,3}$/.test(t) ? t.toUpperCase() : null;
}

/** Parse a command message. Pure: the whole grammar lives here. */
export function parseRadioCommand(text: string): RadioCommand | { error: string } {
  const t = text.trim();
  if (!t) return { error: "empty message - send HELP" };
  const [head = "", ...rest] = t.split(/\s+/);
  const word = head.toUpperCase();
  if (word === "HELP" || word === "?") return { command: "help" };
  if (word === "MAIL") {
    const to = (rest[0] ?? "").toUpperCase();
    if (!/^(?=[A-Z0-9]*\d)[A-Z0-9]{1,6}(-\d{1,2})?$/.test(to))
      return { error: "MAIL needs a callsign, e.g. MAIL OE5XYZ hi" };
    const body = rest.slice(1).join(" ").trim();
    return body ? { command: "mail", to, body } : { error: "MAIL needs a text" };
  }
  if (word === "NEAR") {
    const arg = rest.length === 1 ? rest[0]!.toUpperCase() : "";
    return arg === "ON" || arg === "OFF"
      ? { command: "near", on: arg === "ON" }
      : { error: "send NEAR ON or NEAR OFF" };
  }
  if (word !== "FOUND" && word !== "DNF" && word !== "NOTE") return { error: "unknown command - send HELP" };
  const code = rest[0] ? normalizeCacheCode(rest[0]) : null;
  if (!code) return { error: `${word} needs a cache code, e.g. ${word} AC-1234` };
  const body = rest.slice(1).join(" ").trim();
  if (word === "NOTE") return body ? { command: "note", code, body } : { error: "NOTE needs a text" };
  return { command: word === "FOUND" ? "found" : "dnf", code, ...(body ? { body } : {}) };
}

/** An APRS101 message number: one to five letters or digits. Anything else is not a number to ack. */
const MSG_NO = /^[A-Za-z0-9]{1,5}$/;

/** The message number when it is a valid APRS101 one, else none (the message is treated as unnumbered). */
const validMsgNo = (n?: string): string | undefined => (n && MSG_NO.test(n) ? n : undefined);

/** Split an APRS message text into its body and message number, tolerating the reply-ack form `{MM}AA`. */
export function splitMessageNumber(text: string, msgNo?: string): { text: string; msgNo?: string } {
  const m = /\{([A-Za-z0-9]{1,5})(\}[A-Za-z0-9]{0,2})?$/.exec(text);
  if (m) return { text: text.slice(0, m.index), msgNo: m[1] };
  const n = validMsgNo(msgNo?.split("}")[0]?.trim());
  return { text, ...(n ? { msgNo: n } : {}) };
}

/**
 * An ack or rej addressed to the service call. The decoder recognises only the lower-case APRS101 form;
 * some radios send `ACK12` / `REJ12`, which must not run as a command (or draw an "unknown command" reply).
 */
const isAckOrRej = (text: string) => /^(ack|rej)[A-Za-z0-9]{1,5}$/i.test(text.trim());

/**
 * Text as an APRS101 message body: printable ASCII only, without the reserved `|`, `~` and `{`, within the
 * 67-character limit. Dashes that are not ASCII become `-`; any other non-ASCII character is dropped.
 */
function aprsText(text: string): string {
  return text
    .replace(/[\u2010-\u2015]/g, "-")
    .replace(/[^\x20-\x7e]/g, "")
    .replace(/[|~{]/g, "")
    .slice(0, APRS_TEXT_MAX);
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
  /** The enrolled box whose signed request delivered it, from its verified signature: a site trusted through
   *  a box attests only what that box delivers. Absent on the shared secret. */
  deliveredBy?: string;
}

/**
 * Is this message accepted as the sender's own without a confirmation in the app? A signed batch is; an
 * unsigned one only when the provenance rule attests it, which admits the ingest box's own on-air ports
 * (its TNCs and MeshCom nodes) at an attested site. APRS-IS and the internet-tunnelled ports never count as
 * heard at a site, whatever path the frame carries.
 */
export function isTrustedMessage(m: RadioMessage, attestedSites: Set<string>): boolean {
  if (m.signed) return true;
  return provenanceOf(
    {
      heard_via: m.heardVia,
      igate_call: m.igateCall ?? null,
      path: m.path.join(","),
      transport: transportForPort(m.port, false),
    },
    attestedSites,
  ).firstPartyAttested;
}

/** Transports on which the ingest box itself hears the air: its TNCs and its MeshCom nodes. */
const HEARD_ON_AIR: ReadonlySet<Transport> = new Set<Transport>(["tnc", "meshcom"]);

/**
 * Did the ingest box hear this message on its own radio at an attested site? Only a trusted-ingest copy
 * counts: a signed batch comes from the browser RF bridge on the sender's own computer, which can put any
 * port, path or site on what it sends, and APRS-IS or a tunnel is never a hearing at a site.
 */
function heardAtAttestedSite(m: RadioMessage, attestedSites: Set<string>): boolean {
  if (m.signed) return false;
  const transport = transportForPort(m.port, false);
  if (!HEARD_ON_AIR.has(transport)) return false;
  return provenanceOf(
    { heard_via: m.heardVia, igate_call: m.igateCall ?? null, path: m.path.join(","), transport },
    attestedSites,
  ).firstPartyAttested;
}

type CacheForLog = CacheRow & {
  id: number;
  code: string;
  title: string;
  status: string;
  owner_call: string;
  source: string | null;
};

interface CommandRow {
  id: number;
  from_call: string;
  raw_text: string;
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
    .bind(nowS(), serviceCall(env), encodeAprsMessage(to, text))
    .run();
}

const repliesEnabled = (env: Env) => env.RADIO_REPLIES === "1";

/** Ports on which the ingest box itself received the frame over a radio it can also transmit on. */
const RF_PORTS = new Set(["kiss-tnc"]);

/** An APRS addressee field: exactly nine characters, space-padded or truncated. */
const addressee = (call: string) => call.toUpperCase().slice(0, 9).padEnd(9);

/**
 * Send `text` to the sender the way the message came: through the box that heard it when that box is
 * polling and can transmit on the same radio, else — for APRS — through the APRS-IS outbox. Every answer
 * counts against {@link RADIO_ANSWERS_PER_HOUR}; over it nothing is sent. Returns whether it was queued.
 */
async function answer(env: Env, m: RadioMessage, raw: string): Promise<boolean> {
  const text = aprsText(raw);
  const caps = m.box ? await freshBoxCaps(env, m.box) : null;
  const meshNode = m.port === "meshcom" ? m.rxCall?.toUpperCase() : undefined;
  const viaMesh = !!(caps?.tx && meshNode && caps.meshcom.includes(meshNode));
  if (m.port === "meshcom" && !viaMesh) return false;
  if (await rateLimitedDurable(env, "radio:answers", Date.now(), RADIO_ANSWERS_PER_HOUR, 3600_000)) return false;
  if (viaMesh) {
    // from the service call: the box sends it as that call through the node's KISS port when it can
    await enqueueSystemBoxCommand(env, m.box!, "meshcom_msg", {
      node: meshNode,
      dst: m.src.toUpperCase(),
      text,
      from: serviceCall(env),
    });
  } else if (caps?.tx && caps.rf && RF_PORTS.has(m.port)) {
    await enqueueSystemBoxCommand(env, m.box!, "aprs_msg", { from: serviceCall(env), to: m.src.toUpperCase(), text });
  } else {
    await queueAprs(env, m.src, text);
  }
  return true;
}

/**
 * Acknowledge a numbered message so the sender's radio stops retrying. MeshCom offers an external client
 * no ack frame; its receive path recognises a text message `SENDER   :ack<nnn>` as the acknowledgement of
 * message nnn and matches it by number alone, so the node that heard the message can ack it that way.
 */
function ackText(port: string, src: string, msgNo: string): string {
  return port === "meshcom" ? `${addressee(src)}:ack${msgNo}` : `ack${msgNo}`;
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
    .bind(m.src.toUpperCase(), nowS() - RADIO_REPLY_INTERVAL_SEC)
    .first();
  if (recent) return;
  if (!(await answer(env, m, text))) return;
  await env.DB.prepare("UPDATE radio_commands SET replied_at = ? WHERE id = ?").bind(nowS(), rowId).run();
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
      nowS(),
      f.status === "pending" ? null : nowS(),
    )
    .run();
  return Number(r.meta?.last_row_id);
}

/** The reply text for a logged find, in the player's tier names: Tier A is Radio-verified, Tier B Location-verified. */
export const foundText = (code: string, s: Pick<FindScore, "result">) =>
  s.result.verified && s.result.tier === "A"
    ? `${code} found, Radio-verified`
    : s.result.verified && s.result.tier === "B"
      ? `${code} found, Location-verified`
      : `${code} found, logged, not verified`;

/** Commit a command's log. Returns the new log id, or `duplicate` when the player already found the cache. */
async function commitCommand(
  env: Env,
  row: Pick<CommandRow, "from_call" | "account_id" | "command" | "body" | "sent_at">,
  cache: CacheForLog,
  score: FindScore | null,
): Promise<{ logId?: number; duplicate?: boolean; refused?: string }> {
  // checked again at commit: a cache archived, or a find logged another way, while the command waited
  const refused = await logRefusal(env, cache, row.from_call, row.command, row.account_id);
  if (refused) return { refused };
  if (row.command === "found") {
    if (await alreadyFound(env, cache.id, row.from_call, row.account_id)) return { duplicate: true };
    const c = await commitFind(env, cache, row.from_call, row.sent_at, row.body, score!);
    return c.duplicate ? { duplicate: true } : { logId: c.logId };
  }
  const logType = row.command === "dnf" ? "dnf" : "note";
  const logId = await commitPlainLog(env, cache.id, row.from_call, row.sent_at, logType, row.body);
  await applyLogEffects(env, cache, row.from_call, logType, logId);
  return { logId };
}

async function loadCache(env: Env, id: number): Promise<CacheForLog | null> {
  return env.DB.prepare("SELECT * FROM caches WHERE id = ?").bind(id).first<CacheForLog>();
}

/**
 * Handle one command message. Every accepted outcome is recorded in `radio_commands`, and a numbered APRS
 * message is acknowledged so the sender's radio stops retrying — except over the hourly limit, where the
 * message is dropped without a record or an answer.
 */
export async function handleRadioMessage(env: Env, input: RadioMessage): Promise<void> {
  const m: RadioMessage = { ...input };
  const msgNo = validMsgNo(input.msgNo);
  if (msgNo) m.msgNo = msgNo;
  else delete m.msgNo;
  const src = m.src.toUpperCase();
  if (src === serviceCall(env)) return; // never answer ourselves
  if (isAckOrRej(m.text)) return;

  const verifyCode = parseVerifyMessage(m.text);
  if (verifyCode !== null) return handleVerifyMessage(env, m, verifyCode);

  // A retry of a message already handled — same number and the same text, or the same text when
  // unnumbered: re-ack only. A copy heard at an attested site upgrades a pending command to logged. A
  // message that reuses a number with different text is a new command: matching on the number alone
  // would let a later message confirm an earlier, possibly forged, one.
  const trusted = isTrustedMessage(m, sitesFor(await attestation(env), m.deliveredBy));
  const prior = await env.DB.prepare(
    `SELECT * FROM radio_commands WHERE from_call = ? AND sent_at >= ? AND raw_text = ?
       AND ((? IS NOT NULL AND msg_no = ?) OR (? IS NULL AND msg_no IS NULL))
     ORDER BY id DESC LIMIT 1`,
  )
    .bind(src, m.ts - DUPLICATE_WINDOW_SEC, m.text, m.msgNo ?? null, m.msgNo ?? null, m.msgNo ?? null)
    .first<CommandRow>();
  if (prior) {
    await ack(env, m);
    if (prior.status === "pending" && trusted) await confirmRow(env, prior, true);
    return;
  }

  // Keyed on the base call, so switching SSIDs does not multiply the budget. Over the limit nothing is
  // recorded or sent, but the message still counts.
  if (await rateLimitedDurable(env, `radio:${baseCall(src)}`, Date.now(), RADIO_COMMANDS_PER_HOUR, 3600_000)) return;

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
  if (parsed.command === "mail") return handleMailCommand(env, m, src, trusted, parsed);
  if (parsed.command === "near") return handleNearCommand(env, m, src, trusted, parsed.on);

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

  // the log belongs to the account holding the sender's base call, and only once that call is verified
  const holder = await baseHolder(env, baseCall(src));
  const acct = holder && (await isCallsignVerified(env, src)) ? { account_id: holder } : null;
  if (!acct) return reject(`${baseCall(src)} is not a verified callsign here - verify it in the app`);

  // a cache the sysop removed answers as a code that names nothing
  const cache = await env.DB.prepare("SELECT * FROM caches WHERE code = ? COLLATE NOCASE AND removed_at IS NULL")
    .bind(parsed.code)
    .first<CacheForLog>();
  if (!cache) return reject(`unknown cache ${parsed.code}`, { accountId: acct.account_id });
  const refused = await logRefusal(env, cache, src, parsed.command, acct.account_id);
  if (refused) return reject(refused, { accountId: acct.account_id, cache });
  if (parsed.command === "found" && (await alreadyFound(env, cache.id, src, acct.account_id)))
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
    { from_call: src, account_id: acct.account_id, command: parsed.command, body: parsed.body ?? null, sent_at: m.ts },
    cache,
    score,
  );
  if (c.refused) return reject(c.refused, { accountId: acct.account_id, cache });
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

/**
 * `MAIL <call> <text>` leaves a Mailbox message under the sender's verified call. A copy the provenance rule
 * attests is held at once; any other copy waits for the sender to confirm it in the app, since the instance
 * puts the text on the air in the sender's name.
 */
async function handleMailCommand(
  env: Env,
  m: RadioMessage,
  src: string,
  trusted: boolean,
  parsed: { to: string; body: string },
): Promise<void> {
  const row = { command: "mail", body: `${parsed.to} ${parsed.body}`, trusted };
  const holder = await baseHolder(env, baseCall(src));
  const accountId = holder && (await isCallsignVerified(env, src)) ? holder : null;
  const finish = async (status: string, text: string, reason: string | null = null) => {
    const id = await insertRow(env, m, { ...row, accountId, status, reason });
    await ack(env, m);
    await reply(env, m, id, text);
  };
  if (!accountId) {
    const reason = `${baseCall(src)} is not a verified callsign here - verify it in the app`;
    return finish("rejected", reason, reason);
  }
  if (!trusted) return finish("pending", `mail for ${parsed.to} received - confirm it in the app`);
  const r = await leaveMail(env, { from: src, accountId, to: parsed.to, body: parsed.body, via: "radio" });
  if ("error" in r) return finish("rejected", r.error, r.error);
  return finish("logged", `mail for ${parsed.to} held`);
}

/**
 * `NEAR ON` / `NEAR OFF` switches the account's "you're near" radio message (nearradio.ts). Switching it off
 * is harmless, so any copy from a call an account holds applies at once. Switching it on makes the instance
 * transmit to the station, and anyone can put any call on an APRS-IS message, so it needs a control-verified
 * call and, like MAIL, applies at once only from a copy the provenance rule attests; any other copy waits
 * for the player to confirm it in the app.
 */
async function handleNearCommand(env: Env, m: RadioMessage, src: string, trusted: boolean, on: boolean): Promise<void> {
  const row = { command: "near", body: on ? "ON" : "OFF", trusted };
  const holder = await baseHolder(env, baseCall(src));
  const verified = !!holder && (await isCallsignVerified(env, src));
  const accountId = on ? (verified ? holder : null) : holder;
  const finish = async (status: string, text: string, reason: string | null = null) => {
    const id = await insertRow(env, m, { ...row, accountId, status, reason });
    await ack(env, m);
    await reply(env, m, id, text);
  };
  if (!accountId) {
    const reason = on
      ? `${baseCall(src)} is not a verified callsign here - verify it in the app`
      : `${baseCall(src)} is not a callsign here`;
    return finish("rejected", reason, reason);
  }
  if (on && !trusted) return finish("pending", "NEAR ON received - confirm it in the app");
  await setNearRadio(env, accountId, on);
  return finish("logged", on ? "near-cache messages on" : "near-cache messages off");
}

/**
 * `VERIFY <code>` completes the sender's callsign control-verification challenge (callsign.ts). Only a
 * copy heard on the air at an attested site counts. Any other copy — over APRS-IS, through a tunnel,
 * from the browser RF bridge or an unattested receiver — is dropped unanswered: it costs no attempt, so
 * nobody off the air can lock a challenge, and no ack tells the sender a site heard them when none did.
 * A heard copy is acked, and a completed challenge answered with a short confirmation.
 */
async function handleVerifyMessage(env: Env, m: RadioMessage, code: string): Promise<void> {
  if (!heardAtAttestedSite(m, sitesFor(await attestation(env), m.deliveredBy))) return;
  const base = baseCall(m.src);
  if (await rateLimitedDurable(env, `radio:${base}`, Date.now(), RADIO_COMMANDS_PER_HOUR, 3600_000)) return;
  const outcome = await completeRfChallenge(env, m.src, code, m.igateCall ?? null);
  await ack(env, m);
  if (outcome === "verified") await answer(env, m, `${base} verified`);
}

/**
 * Turn a pending command into a log. `onAir` marks a confirmation by a later attested copy of the message.
 * The row is claimed (`pending` → `confirming`) before anything is written, so two confirmations racing
 * each other — two taps, or a tap and an attested copy — commit the log once; the loser reports the
 * command as already decided. A failure mid-commit hands the row back as `pending`.
 */
async function confirmRow(
  env: Env,
  row: CommandRow,
  onAir: boolean,
): Promise<{ ok: boolean; reason?: string; logId?: number; taken?: boolean }> {
  const claim = await env.DB.prepare(
    "UPDATE radio_commands SET status = 'confirming' WHERE id = ? AND status = 'pending'",
  )
    .bind(row.id)
    .run();
  if ((claim.meta?.changes ?? 0) !== 1) return { ok: false, taken: true, reason: "already decided" };
  const done = async (status: string, reason: string | null, logId: number | null) =>
    env.DB.prepare(
      "UPDATE radio_commands SET status = ?, reason = ?, log_id = ?, decided_at = ?, trusted = MAX(trusted, ?) WHERE id = ? AND status = 'confirming'",
    )
      .bind(status, reason, logId, nowS(), onAir ? 1 : 0, row.id)
      .run();
  try {
    if (row.command === "mail") {
      const [to = "", ...words] = (row.body ?? "").split(" ");
      const r = row.account_id
        ? await leaveMail(env, {
            from: row.from_call,
            accountId: row.account_id,
            to,
            body: words.join(" "),
            via: "radio",
          })
        : { error: "no verified callsign" };
      if ("error" in r) {
        await done("rejected", r.error, null);
        return { ok: false, reason: r.error };
      }
      await done("logged", null, null);
      return { ok: true };
    }
    if (row.command === "near") {
      if (!row.account_id) {
        await done("rejected", "no verified callsign", null);
        return { ok: false, reason: "no verified callsign" };
      }
      await setNearRadio(env, row.account_id, row.body === "ON");
      await done("logged", null, null);
      return { ok: true };
    }
    const cache = row.cache_id != null ? await loadCache(env, row.cache_id) : null;
    if (!cache) {
      await done("rejected", "the cache no longer exists", null);
      return { ok: false, reason: "the cache no longer exists" };
    }
    const score = row.score ? (JSON.parse(row.score) as FindScore) : null;
    const c = await commitCommand(env, row, cache, score);
    if (c.refused) {
      await done("rejected", c.refused, null);
      return { ok: false, reason: c.refused };
    }
    if (c.duplicate) {
      await done("rejected", `${cache.code} is already logged as found`, null);
      return { ok: false, reason: `${cache.code} is already logged as found` };
    }
    await done("logged", null, c.logId ?? null);
    return { ok: true, logId: c.logId };
  } catch (e) {
    await env.DB.prepare("UPDATE radio_commands SET status = 'pending' WHERE id = ? AND status = 'confirming'")
      .bind(row.id)
      .run();
    throw e;
  }
}

/**
 * The nightly job: expire pending commands nobody confirmed, and purge decided ones after
 * {@link RADIO_COMMAND_RETENTION_SEC} — the log itself lives on in `cache_logs`.
 */
export async function expireRadioCommands(env: Env): Promise<void> {
  await env.DB.prepare(
    "UPDATE radio_commands SET status = 'expired', decided_at = ? WHERE status = 'pending' AND sent_at < ?",
  )
    .bind(nowS(), nowS() - RADIO_PENDING_TTL_SEC)
    .run();
  await env.DB.prepare(
    "DELETE FROM radio_commands WHERE status NOT IN ('pending', 'confirming') AND COALESCE(decided_at, created_at) < ?",
  )
    .bind(nowS() - RADIO_COMMAND_RETENTION_SEC)
    .run();
}

// ---------------------------------------------------------------- API for the signed-in player

/** GET /api/radio/commands — the signed-in account's recent radio commands and the address to send to. */
export async function handleRadioCommandsList(req: Request, env: Env): Promise<Response> {
  const me = await sessionIdentity(req, env);
  if (!me) return json({ error: "sign in first" }, { status: 401 });
  // The account's own commands, and the ones refused before they had an account — an unparsable message, or one
  // from a call not verified yet — sent from a call the account holds, so the player sees why nothing was logged.
  const rows = (
    await env.DB.prepare(
      `SELECT id, from_call AS fromCall, command, cache_code AS cacheCode, body, trusted, status, reason, score,
              sent_at AS sentAt, decided_at AS decidedAt
         FROM radio_commands rc
        WHERE account_id = ?
           OR (account_id IS NULL AND EXISTS (SELECT 1 FROM account_callsigns ac WHERE ac.account_id = ?
                 AND (rc.from_call = ac.callsign OR rc.from_call LIKE ac.callsign || '-%')))
        ORDER BY sent_at DESC LIMIT 50`,
    )
      .bind(me.accountId, me.accountId)
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
      .bind(nowS(), id)
      .run();
    return { status: 200, body: { ok: true, status: "discarded" } };
  }
  const r = await confirmRow(env, row, false);
  if (r.taken) return { status: 409, body: { error: "already decided" } };
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
  const me = await sessionIdentity(req, env);
  if (!me) return json({ error: "sign in first" }, { status: 401 });
  const r = await decideRadioCommand(env, me.accountId, id, decision);
  return json(r.body, { status: r.status });
}
