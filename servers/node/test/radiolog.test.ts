// SPDX-License-Identifier: AGPL-3.0-or-later
// Logging finds by radio message, end to end against real SQLite: trust by where the message was
// heard, attribution to the verified account, pending confirmation, acks, replies, retries and limits.
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { makeD1 } from "../src/d1.js";
import { migrate } from "../src/migrate.js";
import {
  handleRadioMessage,
  handleRadioCommandsList,
  decideRadioCommand,
  expireRadioCommands,
  RADIO_COMMANDS_PER_HOUR,
  RADIO_ANSWERS_PER_HOUR,
  HELP_TEXT,
  type RadioMessage,
} from "@aprscaching/gateway/radiolog";
import { handleAccountExport, handleAccountDelete } from "@aprscaching/gateway/account";
import { issueSessionCookie } from "@aprscaching/gateway/auth";
import type { Env } from "@aprscaching/gateway/env";
import { handleBoxPoll } from "@aprscaching/gateway/box";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MIGRATIONS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../db/migrations");
const CACHE = { lat: 47.07, lon: 15.42 };

let sqlite: Database.Database;
let env: Env;
let t: number;

function freshEnv(extra: Record<string, string> = {}) {
  sqlite = new Database(":memory:");
  migrate(sqlite, MIGRATIONS);
  env = { DB: makeD1(sqlite), FIRST_PARTY_SITES: "OE8XXX-10", ...extra } as unknown as Env;
  t = Math.floor(Date.now() / 1000);
  sqlite
    .prepare(
      "INSERT INTO caches (code, owner_call, title, type, lat, lon, created_at, updated_at) VALUES ('AC-0001','OE3OWN','Test cache','traditional',?,?,?,?)",
    )
    .run(CACHE.lat, CACHE.lon, t, t);
  sqlite
    .prepare(
      "INSERT INTO account_callsigns (account_id, callsign, added_at) VALUES ('acct-apr','OE8APR',?), ('acct-new','OE5NEW',?)",
    )
    .run(t, t);
  // OE8APR is control-verified; OE5NEW is held but not
  sqlite
    .prepare(
      "INSERT INTO callsign_verifications (callsign, method, status, verified_at) VALUES ('OE8APR','operator','verified',?)",
    )
    .run(t);
}

/** The player's own beacon at the cache, heard directly at the attested site OE8XXX-10. */
function beaconAtCache(call = "OE8APR-7", ago = 120) {
  sqlite
    .prepare(
      "INSERT INTO positions (callsign, ts, lat, lon, heard_via, igate_call, path, source, transport) VALUES (?,?,?,?, 'rf', 'OE8XXX-10', 'WIDE1-1', 'firehose', 'tnc')",
    )
    .run(call, t - ago, CACHE.lat, CACHE.lon);
}

const onAir = (o: Partial<RadioMessage> = {}): RadioMessage => ({
  src: "OE8APR-7",
  text: "FOUND AC-0001 nice spot",
  msgNo: "12",
  ts: t,
  port: "kiss-tnc",
  heardVia: "rf",
  igateCall: "OE8XXX-10",
  path: ["WIDE1-1"],
  signed: false,
  ...o,
});
const overIs = (o: Partial<RadioMessage> = {}) =>
  onAir({ port: "aprs-is", heardVia: "aprs_is", igateCall: "T2TEST", path: ["TCPIP*", "qAC", "T2TEST"], ...o });

const commands = () => sqlite.prepare("SELECT * FROM radio_commands ORDER BY id").all() as Record<string, unknown>[];
const logs = () => sqlite.prepare("SELECT * FROM cache_logs ORDER BY id").all() as Record<string, unknown>[];
const outbox = () =>
  (
    sqlite.prepare("SELECT src_call, payload FROM aprs_outbox ORDER BY id").all() as {
      src_call: string;
      payload: string;
    }[]
  ).map((r) => `${r.src_call} ${r.payload}`);

beforeEach(() => freshEnv());

describe("a command heard at an attested RF site", () => {
  it("logs the find to the sender at once, scored Tier A from their beacon, and acks it", async () => {
    beaconAtCache();
    await handleRadioMessage(env, onAir());
    const [log] = logs();
    expect(log).toMatchObject({
      logger_call: "OE8APR-7",
      log_type: "found",
      tier: "A",
      verified: 1,
      comment: "nice spot",
    });
    expect(commands()[0]).toMatchObject({ status: "logged", account_id: "acct-apr", trusted: 1, log_id: log!.id });
    expect(outbox()).toEqual(["APRSCG :OE8APR-7 :ack12"]);
  });

  it("is Tier C when the player never beaconed near the cache", async () => {
    await handleRadioMessage(env, onAir());
    expect(logs()[0]).toMatchObject({ tier: "C", verified: 0 });
  });

  it("logs DNF and NOTE as plain records", async () => {
    await handleRadioMessage(env, onAir({ text: "DNF AC-0001 muggles", msgNo: "1" }));
    await handleRadioMessage(env, onAir({ text: "NOTE AC-0001 log is full", msgNo: "2" }));
    expect(logs().map((l) => [l.log_type, l.comment])).toEqual([
      ["dnf", "muggles"],
      ["note", "log is full"],
    ]);
  });
});

describe("a command that arrived only over the internet", () => {
  it("waits as pending, acked, without a log", async () => {
    beaconAtCache();
    await handleRadioMessage(env, overIs());
    expect(logs()).toHaveLength(0);
    expect(commands()[0]).toMatchObject({ status: "pending", trusted: 0 });
    expect(outbox()).toEqual(["APRSCG :OE8APR-7 :ack12"]);
  });

  it("becomes a log when the player confirms it, with the tier scored at message time", async () => {
    beaconAtCache();
    await handleRadioMessage(env, overIs());
    // the beacon is pruned before the player confirms: the stored score still applies
    sqlite.prepare("DELETE FROM positions").run();
    const id = Number(commands()[0]!.id);
    const r = await decideRadioCommand(env, "acct-apr", id, "confirm");
    expect(r.status).toBe(200);
    expect(logs()[0]).toMatchObject({ tier: "A", verified: 1, ts: t });
    expect(commands()[0]).toMatchObject({ status: "logged" });
  });

  it("another account can neither see nor confirm it", async () => {
    await handleRadioMessage(env, overIs());
    const id = Number(commands()[0]!.id);
    expect((await decideRadioCommand(env, "acct-new", id, "confirm")).status).toBe(404);
    expect(logs()).toHaveLength(0);
  });

  it("can be discarded, and a decided command cannot be decided again", async () => {
    await handleRadioMessage(env, overIs());
    const id = Number(commands()[0]!.id);
    expect((await decideRadioCommand(env, "acct-apr", id, "discard")).status).toBe(200);
    expect((await decideRadioCommand(env, "acct-apr", id, "confirm")).status).toBe(409);
    expect(logs()).toHaveLength(0);
  });

  it("is logged when a copy of the same message is then heard at an attested site", async () => {
    await handleRadioMessage(env, overIs());
    await handleRadioMessage(env, onAir());
    expect(commands()).toHaveLength(1);
    expect(commands()[0]).toMatchObject({ status: "logged", trusted: 1 });
    expect(logs()).toHaveLength(1);
  });

  it("a signed browser batch from the sender's own device logs at once", async () => {
    await handleRadioMessage(env, overIs({ signed: true, igateCall: null }));
    expect(commands()[0]).toMatchObject({ status: "logged" });
  });

  it("expires after seven days unconfirmed", async () => {
    await handleRadioMessage(env, overIs({ ts: t - 8 * 24 * 3600 }));
    await expireRadioCommands(env);
    expect(commands()[0]).toMatchObject({ status: "expired" });
  });
});

describe("attribution and rejection", () => {
  it("a callsign that is not verified here is acked and rejected", async () => {
    await handleRadioMessage(env, onAir({ src: "OE5NEW" }));
    expect(commands()[0]).toMatchObject({ status: "rejected", account_id: null });
    expect(String(commands()[0]!.reason)).toMatch(/not a verified callsign/);
    expect(logs()).toHaveLength(0);
    expect(outbox()).toEqual(["APRSCG :OE5NEW   :ack12"]);
  });

  it("an unknown cache and a malformed command are rejected with a reason", async () => {
    await handleRadioMessage(env, onAir({ text: "FOUND AC-9999", msgNo: "1" }));
    await handleRadioMessage(env, onAir({ text: "FOUND", msgNo: "2" }));
    expect(commands().map((c) => c.reason)).toEqual([
      "unknown cache AC-9999",
      "FOUND needs a cache code, e.g. FOUND AC-1234",
    ]);
  });

  it("a second FOUND for the same cache is rejected as already logged", async () => {
    await handleRadioMessage(env, onAir({ msgNo: "1" }));
    await handleRadioMessage(env, onAir({ msgNo: "2" }));
    expect(logs()).toHaveLength(1);
    expect(commands()[1]).toMatchObject({ status: "rejected", reason: "AC-0001 is already logged as found" });
  });
});

describe("retries, limits and replies", () => {
  it("a retry with the same message number runs once and is acked each time", async () => {
    await handleRadioMessage(env, onAir());
    await handleRadioMessage(env, onAir());
    expect(commands()).toHaveLength(1);
    expect(logs()).toHaveLength(1);
    expect(outbox()).toEqual(["APRSCG :OE8APR-7 :ack12", "APRSCG :OE8APR-7 :ack12"]);
  });

  it(`more than ${RADIO_COMMANDS_PER_HOUR} commands an hour are dropped without a record or an ack`, async () => {
    for (let i = 0; i <= RADIO_COMMANDS_PER_HOUR + 2; i++)
      await handleRadioMessage(env, onAir({ text: "DNF AC-0001", msgNo: String(i) }));
    expect(logs()).toHaveLength(RADIO_COMMANDS_PER_HOUR);
    expect(commands()).toHaveLength(RADIO_COMMANDS_PER_HOUR);
    expect(outbox()).toHaveLength(RADIO_COMMANDS_PER_HOUR);
  });

  it("the hourly limit is per person: every SSID of a base call shares it", async () => {
    for (let i = 0; i <= RADIO_COMMANDS_PER_HOUR; i++)
      await handleRadioMessage(
        env,
        onAir({ src: i % 2 ? "OE8APR-9" : "OE8APR-7", text: "DNF AC-0001", msgNo: String(i) }),
      );
    expect(logs()).toHaveLength(RADIO_COMMANDS_PER_HOUR);
  });

  it(`the service queues at most ${RADIO_ANSWERS_PER_HOUR} acks and replies an hour in total`, async () => {
    for (let i = 0; i < RADIO_ANSWERS_PER_HOUR + 5; i++)
      await handleRadioMessage(env, onAir({ src: `DL${i}XX`, text: "HELLO", msgNo: "1" }));
    expect(outbox()).toHaveLength(RADIO_ANSWERS_PER_HOUR);
  });

  it("text replies are off by default, but HELP is always answered", async () => {
    await handleRadioMessage(env, onAir({ msgNo: undefined }));
    expect(outbox()).toEqual([]);
    await handleRadioMessage(env, onAir({ text: "HELP", msgNo: undefined }));
    expect(outbox()).toEqual([`APRSCG :OE8APR-7 :${HELP_TEXT}`]);
  });

  it("with RADIO_REPLIES=1 a logged find is answered, at most once per destination per 10 minutes", async () => {
    freshEnv({ RADIO_REPLIES: "1" });
    beaconAtCache();
    await handleRadioMessage(env, onAir({ msgNo: undefined }));
    await handleRadioMessage(env, onAir({ text: "NOTE AC-0001 thanks", msgNo: undefined }));
    expect(outbox()).toEqual(["APRSCG :OE8APR-7 :AC-0001 found, Radio-verified"]);
  });

  it("replies and acks come from SERVICE_CALL when set", async () => {
    freshEnv({ SERVICE_CALL: "OE8APR-5" });
    await handleRadioMessage(env, onAir());
    expect(outbox()).toEqual(["OE8APR-5 :OE8APR-7 :ack12"]);
  });

  it("a MeshCom command is handled but not acked through the APRS outbox", async () => {
    await handleRadioMessage(env, onAir({ port: "meshcom" }));
    expect(logs()).toHaveLength(1);
    expect(outbox()).toEqual([]);
  });
});

describe("answers go back the way the message came", () => {
  const boxCommands = () =>
    (
      sqlite.prepare("SELECT box_id, kind, payload FROM box_commands ORDER BY id").all() as {
        box_id: string;
        kind: string;
        payload: string;
      }[]
    ).map((r) => ({ box: r.box_id, kind: r.kind, ...JSON.parse(r.payload) }));
  const poll = (query: string) =>
    handleBoxPoll(
      new Request(`http://gw/api/box/pi-home/commands?${query}`, { headers: { "x-ingest-secret": "s" } }),
      env,
      "pi-home",
    );

  beforeEach(() => freshEnv({ INGEST_SECRET: "s" }));

  it("a message heard on the box's own radio is acked by that box on RF, not over APRS-IS", async () => {
    await poll("tx=1&rf=1&meshcom=");
    await handleRadioMessage(env, onAir({ box: "pi-home", rxCall: "OE8XXX-10" }));
    expect(boxCommands()).toEqual([
      { box: "pi-home", kind: "aprs_msg", from: "APRSCG", to: "OE8APR-7", text: "ack12" },
    ]);
    expect(outbox()).toEqual([]);
  });

  it("falls back to the outbox when the box cannot transmit or has stopped polling", async () => {
    await poll("tx=0&rf=1&meshcom=");
    await handleRadioMessage(env, onAir({ box: "pi-home", msgNo: "1" }));
    sqlite.prepare("UPDATE box_status SET caps = ?, last_seen = ?").run('{"tx":true,"rf":true,"meshcom":[]}', t - 600);
    await handleRadioMessage(env, onAir({ box: "pi-home", msgNo: "2", text: "DNF AC-0001" }));
    expect(boxCommands()).toEqual([]);
    expect(outbox()).toEqual(["APRSCG :OE8APR-7 :ack1", "APRSCG :OE8APR-7 :ack2"]);
  });

  it("a message the box only received over APRS-IS is still acked over APRS-IS", async () => {
    await poll("tx=1&rf=1&meshcom=");
    await handleRadioMessage(env, overIs({ box: "pi-home" }));
    expect(boxCommands()).toEqual([]);
    expect(outbox()).toEqual(["APRSCG :OE8APR-7 :ack12"]);
  });

  it("a MeshCom message is acked through the node that heard it, in the form the firmware recognises", async () => {
    await poll("tx=1&rf=0&meshcom=OE8APR-12");
    await handleRadioMessage(
      env,
      onAir({ port: "meshcom", box: "pi-home", rxCall: "OE8APR-12", igateCall: "OE8APR-12", msgNo: "034" }),
    );
    expect(boxCommands()).toEqual([
      {
        box: "pi-home",
        kind: "meshcom_msg",
        node: "OE8APR-12",
        dst: "OE8APR-7",
        text: "OE8APR-7 :ack034",
        from: "APRSCG", // the box sends it as the service call when it reaches the node's KISS port
      },
    ]);
    expect(outbox()).toEqual([]);
  });

  it("a MeshCom message gets no answer when its node's box cannot send", async () => {
    await poll("tx=1&rf=0&meshcom=OE8APR-99");
    await handleRadioMessage(env, onAir({ port: "meshcom", box: "pi-home", rxCall: "OE8APR-12", msgNo: "034" }));
    expect(boxCommands()).toEqual([]);
    expect(outbox()).toEqual([]);
    expect(logs()).toHaveLength(1);
  });

  it("HELP is answered through the box too", async () => {
    await poll("tx=1&rf=1&meshcom=");
    await handleRadioMessage(env, onAir({ box: "pi-home", text: "HELP", msgNo: undefined }));
    expect(boxCommands()).toEqual([
      {
        box: "pi-home",
        kind: "aprs_msg",
        from: "APRSCG",
        to: "OE8APR-7",
        text: HELP_TEXT,
      },
    ]);
  });
});

describe("hardening", () => {
  it("a same-number message with different text is a new command, not a retry of the first", async () => {
    await handleRadioMessage(env, overIs({ text: "FOUND AC-0001 spoofed", msgNo: "12" }));
    await handleRadioMessage(env, onAir({ text: "DNF AC-0001 real", msgNo: "12" }));
    expect(logs().map((l) => [l.log_type, l.comment])).toEqual([["dnf", "real"]]);
    expect(commands().map((c) => c.status)).toEqual(["pending", "logged"]);
  });

  it("a forged qAR path naming an attested site over APRS-IS stays pending", async () => {
    await handleRadioMessage(
      env,
      overIs({ heardVia: "rf", igateCall: "OE8XXX-10", path: ["WIDE1-1", "qAR", "OE8XXX-10"] }),
    );
    expect(logs()).toHaveLength(0);
    expect(commands()[0]).toMatchObject({ status: "pending", trusted: 0 });
  });

  it("a message number outside APRS101 is treated as unnumbered and never echoed", async () => {
    await handleRadioMessage(env, onAir({ msgNo: "visit evil.example | now" }));
    expect(outbox().some((o) => o.includes("evil"))).toBe(false);
    expect(commands()[0]).toMatchObject({ msg_no: null });
  });

  it("every answer is APRS101-clean ASCII with a nine-character addressee", async () => {
    freshEnv({ RADIO_REPLIES: "1" });
    await handleRadioMessage(env, onAir({ text: "HELLO", msgNo: "1" }));
    await handleRadioMessage(env, onAir({ src: "OE8APRLONG-12", text: "HELP", msgNo: "2" }));
    const payloads = (sqlite.prepare("SELECT payload FROM aprs_outbox").all() as { payload: string }[]).map(
      (r) => r.payload,
    );
    expect(payloads.length).toBeGreaterThanOrEqual(3);
    for (const p of payloads) {
      expect(p).toMatch(/^:[\x20-\x7e]{9}:[\x20-\x7e]*$/);
      expect(p.slice(11)).not.toMatch(/[|~{]/);
    }
    expect(payloads).toContain(":OE8APRLON:ack2");
  });

  it("two concurrent confirmations of one command log it once", async () => {
    await handleRadioMessage(env, overIs({ text: "NOTE AC-0001 log is full" }));
    const id = Number(commands()[0]!.id);
    const rs = await Promise.all([
      decideRadioCommand(env, "acct-apr", id, "confirm"),
      decideRadioCommand(env, "acct-apr", id, "confirm"),
    ]);
    expect(logs()).toHaveLength(1);
    expect(rs.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(commands()[0]).toMatchObject({ status: "logged" });
  });

  it("FOUND counts once per person, whichever SSID sends it", async () => {
    await handleRadioMessage(env, onAir({ src: "OE8APR-7", msgNo: "1" }));
    await handleRadioMessage(env, onAir({ src: "OE8APR-9", msgNo: "2" }));
    expect(logs().filter((l) => l.log_type === "found")).toHaveLength(1);
    expect(commands()[1]).toMatchObject({ status: "rejected", reason: "AC-0001 is already logged as found" });
  });

  it("an archived or disabled cache takes no FOUND or DNF over the radio, but a NOTE", async () => {
    sqlite.prepare("UPDATE caches SET status='archived' WHERE code='AC-0001'").run();
    await handleRadioMessage(env, onAir({ msgNo: "1" }));
    await handleRadioMessage(env, onAir({ msgNo: "2", text: "DNF AC-0001" }));
    await handleRadioMessage(env, onAir({ msgNo: "3", text: "NOTE AC-0001 is it gone?" }));
    expect(commands()[0]).toMatchObject({ status: "rejected" });
    expect(String(commands()[0]!.reason)).toMatch(/archived/);
    expect(commands()[1]).toMatchObject({ status: "rejected" });
    expect(logs().map((l) => l.log_type)).toEqual(["note"]);
  });

  it("an owner's FOUND on their own cache is refused", async () => {
    sqlite
      .prepare("INSERT INTO account_callsigns (account_id, callsign, added_at) VALUES ('acct-own','OE3OWN',?)")
      .run(t);
    sqlite
      .prepare(
        "INSERT INTO callsign_verifications (callsign, method, status, verified_at) VALUES ('OE3OWN','operator','verified',?)",
      )
      .run(t);
    await handleRadioMessage(env, onAir({ src: "OE3OWN-7", msgNo: "1" }));
    expect(commands()[0]).toMatchObject({ status: "rejected" });
    expect(String(commands()[0]!.reason)).toMatch(/you own AC-0001/);
    expect(logs()).toHaveLength(0);
  });

  it("a pending FOUND is refused on confirmation when the cache was archived meanwhile", async () => {
    await handleRadioMessage(env, overIs({ msgNo: "1" }));
    sqlite.prepare("UPDATE caches SET status='archived' WHERE code='AC-0001'").run();
    const r = await decideRadioCommand(env, "acct-apr", Number(commands()[0]!.id), "confirm");
    expect(r.status).toBe(409);
    expect(logs()).toHaveLength(0);
  });

  it("a cache the sysop removed answers every command as an unknown code and takes no log", async () => {
    sqlite.prepare("UPDATE caches SET status='archived', removed_at=? WHERE code='AC-0001'").run(t);
    await handleRadioMessage(env, onAir({ msgNo: "1", text: "NOTE AC-0001 still here?" }));
    await handleRadioMessage(env, onAir({ msgNo: "2", text: "FOUND AC-0001" }));
    expect(commands().map((c) => [c.status, c.reason, c.cache_id])).toEqual([
      ["rejected", "unknown cache AC-0001", null],
      ["rejected", "unknown cache AC-0001", null],
    ]);
    expect(logs()).toHaveLength(0);
  });

  it("a pending NOTE is refused on confirmation when the sysop removed the cache meanwhile", async () => {
    await handleRadioMessage(env, overIs({ msgNo: "1", text: "NOTE AC-0001 hello" }));
    sqlite.prepare("UPDATE caches SET status='archived', removed_at=? WHERE code='AC-0001'").run(t);
    const r = await decideRadioCommand(env, "acct-apr", Number(commands()[0]!.id), "confirm");
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("unknown cache AC-0001");
    expect(logs()).toHaveLength(0);
  });

  it("a pending FOUND from another SSID is refused on confirmation once the person has found the cache", async () => {
    await handleRadioMessage(env, overIs({ src: "OE8APR-9", msgNo: "1" }));
    await handleRadioMessage(env, onAir({ src: "OE8APR-7", msgNo: "2" }));
    const r = await decideRadioCommand(env, "acct-apr", Number(commands()[0]!.id), "confirm");
    expect(r.status).toBe(409);
    expect(logs()).toHaveLength(1);
  });

  it("GDPR export and erase cover logs written under an SSID of the callsign", async () => {
    freshEnv({ INGEST_SECRET: "a-strong-test-secret", SESSION_SECRET: "a-strong-session-secret", INSTANCE: "gw.test" });
    sqlite.prepare("INSERT INTO accounts (account_id, callsign, created_at) VALUES ('acct-apr','OE8APR',?)").run(t);
    await handleRadioMessage(env, onAir());
    const cookie = (await issueSessionCookie(new Request("http://gw/"), env, "acct-apr", "OE8APR")).split(";")[0]!;
    const req = () => new Request("http://gw.test/x", { method: "POST", headers: { cookie } });
    const exp = (await (await handleAccountExport(req(), env, "OE8APR")).json()) as { logs: unknown[] };
    expect(exp.logs).toHaveLength(1);
    const del = (await (await handleAccountDelete(req(), env, "OE8APR")).json()) as { tombstones: number };
    expect(del.tombstones).toBe(1);
    expect(logs()[0]).toMatchObject({ logger_call: expect.stringMatching(/^WITHDRAWN#/), comment: null });
  });

  it("erase succeeds when the base call and an SSID both hold a found for the same cache", async () => {
    freshEnv({ INGEST_SECRET: "a-strong-test-secret", SESSION_SECRET: "a-strong-session-secret", INSTANCE: "gw.test" });
    sqlite.prepare("INSERT INTO accounts (account_id, callsign, created_at) VALUES ('acct-apr','OE8APR',?)").run(t);
    sqlite
      .prepare(
        "INSERT INTO cache_logs (cache_id, logger_call, ts, log_type, verified, tier) VALUES (1,'OE8APR',?,'found',0,'C'), (1,'OE8APR-7',?,'found',0,'C')",
      )
      .run(t - 10, t);
    const cookie = (await issueSessionCookie(new Request("http://gw/"), env, "acct-apr", "OE8APR")).split(";")[0]!;
    const res = await handleAccountDelete(
      new Request("http://gw.test/x", { method: "POST", headers: { cookie } }),
      env,
      "OE8APR",
    );
    expect(res.status).toBe(200);
    expect(logs().map((l) => l.logger_call)).toEqual([expect.stringMatching(/^WITHDRAWN#/)]);
  });

  it("uppercase ACK and REJ to the service call are acks, not commands", async () => {
    freshEnv({ RADIO_REPLIES: "1" });
    await handleRadioMessage(env, onAir({ text: "ACK12", msgNo: undefined }));
    await handleRadioMessage(env, onAir({ text: "REJ3", msgNo: undefined }));
    expect(commands()).toHaveLength(0);
    expect(outbox()).toEqual([]);
  });

  it("decided commands are purged after 30 days; pending ones are kept until they expire", async () => {
    await handleRadioMessage(env, onAir({ text: "DNF AC-0001", msgNo: "1" }));
    await handleRadioMessage(env, overIs({ text: "NOTE AC-0001 x", msgNo: "2" }));
    await handleRadioMessage(env, onAir({ text: "DNF AC-0001 recent", msgNo: "3" }));
    sqlite
      .prepare("UPDATE radio_commands SET created_at = ?, decided_at = ? WHERE msg_no = '1'")
      .run(t - 31 * 24 * 3600, t - 31 * 24 * 3600);
    sqlite.prepare("UPDATE radio_commands SET created_at = ? WHERE msg_no = '2'").run(t - 31 * 24 * 3600);
    await expireRadioCommands(env);
    expect(commands().map((c) => c.msg_no)).toEqual(["2", "3"]);
  });
});

describe("the player's list of logs sent over the air", () => {
  it("shows a command refused because the call is not verified yet, with its reason, to the call's holder only", async () => {
    freshEnv({ SESSION_SECRET: "a-strong-session-secret", INSTANCE: "gw.test" });
    sqlite
      .prepare(
        "INSERT INTO accounts (account_id, callsign, created_at) VALUES ('acct-new','OE5NEW',?), ('acct-apr','OE8APR',?)",
      )
      .run(t, t);
    await handleRadioMessage(env, onAir({ src: "OE5NEW-7" }));
    const list = async (acct: string, call: string) => {
      const cookie = (await issueSessionCookie(new Request("http://gw/"), env, acct, call)).split(";")[0]!;
      const res = await handleRadioCommandsList(new Request("http://gw.test/x", { headers: { cookie } }), env);
      return ((await res.json()) as { commands: { fromCall: string; status: string; reason: string }[] }).commands;
    };
    expect(await list("acct-new", "OE5NEW")).toEqual([
      expect.objectContaining({
        fromCall: "OE5NEW-7",
        status: "rejected",
        reason: expect.stringContaining("not a verified callsign"),
      }),
    ]);
    expect(await list("acct-apr", "OE8APR")).toEqual([]);
  });
});
