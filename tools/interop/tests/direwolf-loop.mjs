// SPDX-License-Identifier: AGPL-3.0-or-later
// Transport conformance against two REAL Direwolf modems joined by an audio cable: every frame below
// is modulated as Bell-202 1200 bd AFSK by one Direwolf and demodulated by the other.
//   KISS  -> AFSK -> AGWPE: our KISS TCP client keys dw-a; our AGWPE client hears it on dw-b.
//   AGWPE -> AFSK -> KISS:  our AGWPE client keys dw-b; our KISS TCP client hears it on dw-a.
//   IGate: a position keyed on dw-b is heard by dw-a, whose KISS client is the acs ingest; its
//          RX-IGate must deliver it to aprsc as `<src>>APZACG,WIDE1-1,qAR,OE1ACS-10:<info>`, and a
//          frame whose path carries RFONLY must never reach APRS-IS.
// Runs under tsx (imports the ingest's TS sources):
//   pnpm -C apps/ingest exec tsx ../../tools/interop/tests/direwolf-loop.mjs
import net from "node:net";
import { KissTnc } from "../../../apps/ingest/src/kiss.js";
import { AgwpeTnc } from "../../../apps/ingest/src/agwpe.js";

const HOST = process.env.DW_HOST ?? "127.0.0.1";
const KISS_PORT = Number(process.env.DW_A_KISS_PORT ?? 38001);
const AGW_PORT = Number(process.env.DW_B_AGW_PORT ?? 38000);
const FULLFEED_PORT = Number(process.env.DW_APRSC_FULLFEED_PORT ?? 38152);
const IGATE_CALL = "OE1ACS-10";
const TOCALL = "APZACG";
const run = Date.now().toString(36); // payloads carry the run id, so a stale frame never satisfies a check

let failures = 0;
const ok = (name, cond, detail = "") => {
  console.log(`${cond ? "OK " : "FAIL"} ${name}${cond ? "" : `  -- ${detail}`}`);
  if (!cond) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(deadlineMs, check, everyMs = 500) {
  const t0 = Date.now();
  for (;;) {
    const v = await check();
    if (v) return v;
    if (Date.now() - t0 > deadlineMs) return null;
    await sleep(everyMs);
  }
}

const heardOnKiss = [];
const heardOnAgw = [];
const kiss = new KissTnc(
  { host: HOST, port: KISS_PORT, retryMs: 1000 },
  { onPacket: () => {}, onFrame: (f) => heardOnKiss.push(f) },
);
const agw = new AgwpeTnc(
  { host: HOST, port: AGW_PORT, retryMs: 1000 },
  { onPacket: () => {}, onFrame: (f) => heardOnAgw.push(f) },
);
kiss.start();
agw.start();

/**
 * Key `tnc` with `frame` until the far side hears it: send() reports false until the TCP session is up,
 * and a transmission is repeated after a quiet interval so one lost to start-up timing is not a failure.
 */
async function deliver(label, tnc, frame, heard) {
  const match = (f) =>
    f.src === frame.src &&
    f.dst === frame.dst &&
    f.payload === frame.payload &&
    f.path.join(",") === frame.path.join(",");
  const got = await until(45000, async () => {
    const f = heard.find(match);
    if (f) return f;
    if (tnc.send(frame)) await until(8000, async () => heard.find(match));
    return heard.find(match) ?? null;
  });
  ok(
    label,
    !!got,
    `not heard; far side decoded: ${JSON.stringify(heard.map((f) => `${f.src}>${f.dst},${f.path.join(",")}:${f.payload}`))}`,
  );
}

// ---- KISS TCP -> AFSK -> AGWPE ----
await deliver(
  "KISS TCP client on dw-a -> AFSK -> AGWPE client on dw-b (src, dst, path, info intact)",
  kiss,
  { src: "OE1KSS-1", dst: TOCALL, path: ["WIDE2-1"], payload: `>kiss to agwpe ${run}` },
  heardOnAgw,
);

// ---- AGWPE -> AFSK -> KISS TCP ----
await deliver(
  "AGWPE client on dw-b -> AFSK -> KISS TCP client on dw-a (src, dst, path, info intact)",
  agw,
  { src: "OE1AGW-2", dst: TOCALL, path: ["WIDE1-1", "WIDE2-1"], payload: `>agwpe to kiss ${run}` },
  heardOnKiss,
);

// ---- RF -> the ingest's RX-IGate -> aprsc ----
const feed = [];
const is = net.connect(FULLFEED_PORT, HOST);
let isBuf = "";
is.setEncoding("latin1");
is.on("connect", () => is.write("user OE9WCH pass -1 vers aprscaching-interop 1.0\r\n"));
is.on("data", (chunk) => {
  isBuf += chunk;
  let i;
  while ((i = isBuf.indexOf("\n")) >= 0) {
    feed.push(isBuf.slice(0, i).replace(/\r$/, ""));
    isBuf = isBuf.slice(i + 1);
  }
});
is.on("error", () => {});
ok(
  "aprsc full feed answers",
  !!(await until(15000, async () => feed.some((l) => l.startsWith("# aprsc")))),
  "no banner",
);

const rfOnly = { src: "OE9RFO-7", dst: TOCALL, path: ["RFONLY"], payload: `>rf only ${run}` };
const position = {
  src: "OE9TST-9",
  dst: TOCALL,
  path: ["WIDE1-1"],
  payload: `!4704.30N/01526.00E>direwolf igate ${run}`,
};
// the RFONLY frame goes first: once the position (sent after it) has arrived, the RFONLY one has had its chance
await deliver("RFONLY frame keyed on dw-b is heard on dw-a", agw, rfOnly, heardOnKiss);
await deliver("position keyed on dw-b is heard on dw-a", agw, position, heardOnKiss);

const want = `${position.src}>${TOCALL},WIDE1-1,qAR,${IGATE_CALL}:${position.payload}`;
const gated = await until(45000, async () => feed.find((l) => l.includes(position.payload)));
ok("the ingest's IGate delivers the RF position to aprsc", !!gated, `no line with "${position.payload}" in the feed`);
ok(
  `aprsc carries it with the IGate's q-construct and the RF path (${want})`,
  gated === want,
  `got ${JSON.stringify(gated)}`,
);
await sleep(3000);
ok(
  "a frame whose path carries RFONLY never reaches APRS-IS",
  !feed.some((l) => l.includes(rfOnly.payload)),
  JSON.stringify(feed.find((l) => l.includes(rfOnly.payload))),
);

agw.stop();
is.destroy();
console.log(failures ? `\nDIREWOLF TRANSPORTS FAILED (${failures})` : "\nDIREWOLF TRANSPORTS PASSED");
process.exit(failures ? 1 : 0);
