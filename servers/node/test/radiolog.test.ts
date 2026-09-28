// SPDX-License-Identifier: AGPL-3.0-or-later
// Logging finds by radio message, end to end against real SQLite: trust by where the message was
// heard, attribution to the verified account, pending confirmation, acks, replies, retries and limits.
import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { makeD1 } from "../src/d1.js";
import { migrate } from "../src/migrate.js";
import {
  handleRadioMessage,
  decideRadioCommand,
  expireRadioCommands,
  RADIO_COMMANDS_PER_HOUR,
  type RadioMessage,
} from "@aprscaching/gateway/radiolog";
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
      "INSERT INTO account_callsigns (account_id, callsign, verified, added_at) VALUES ('acct-apr','OE8APR',1,?)",
    )
    .run(t);
  sqlite
    .prepare(
      "INSERT INTO account_callsigns (account_id, callsign, verified, added_at) VALUES ('acct-new','OE5NEW',0,?)",
    )
    .run(t);
}

/** The player's own beacon at the cache, heard directly at the attested site OE8XXX-10. */
function beaconAtCache(call = "OE8APR-7", ago = 120) {
  sqlite
    .prepare(
      "INSERT INTO positions (callsign, ts, lat, lon, heard_via, igate_call, path, source) VALUES (?,?,?,?, 'rf', 'OE8XXX-10', 'WIDE1-1,qAR,OE8XXX-10', 'firehose')",
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

  it(`more than ${RADIO_COMMANDS_PER_HOUR} commands an hour are rejected`, async () => {
    for (let i = 0; i <= RADIO_COMMANDS_PER_HOUR; i++)
      await handleRadioMessage(env, onAir({ text: "DNF AC-0001", msgNo: String(i) }));
    expect(logs()).toHaveLength(RADIO_COMMANDS_PER_HOUR);
    expect(commands().at(-1)).toMatchObject({ status: "rejected", reason: "rate limited" });
  });

  it("text replies are off by default, but HELP is always answered", async () => {
    await handleRadioMessage(env, onAir({ msgNo: undefined }));
    expect(outbox()).toEqual([]);
    await handleRadioMessage(env, onAir({ text: "HELP", msgNo: undefined }));
    expect(outbox()).toEqual(["APRSCG :OE8APR-7 :FOUND <code> [log] | DNF <code> [log] | NOTE <code> <text>"]);
  });

  it("with RADIO_REPLIES=1 a logged find is answered, at most once per destination per 10 minutes", async () => {
    freshEnv({ RADIO_REPLIES: "1" });
    beaconAtCache();
    await handleRadioMessage(env, onAir({ msgNo: undefined }));
    await handleRadioMessage(env, onAir({ text: "NOTE AC-0001 thanks", msgNo: undefined }));
    expect(outbox()).toEqual(["APRSCG :OE8APR-7 :AC-0001 found, logged Tier A"]);
  });

  it("replies and acks come from BBS_CALL when set", async () => {
    freshEnv({ BBS_CALL: "OE8APR-5" });
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
      { box: "pi-home", kind: "meshcom_msg", node: "OE8APR-12", dst: "OE8APR-7", text: "OE8APR-7 :ack034" },
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
        text: "FOUND <code> [log] | DNF <code> [log] | NOTE <code> <text>",
      },
    ]);
  });
});
