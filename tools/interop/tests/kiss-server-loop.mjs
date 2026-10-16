// SPDX-License-Identifier: AGPL-3.0-or-later
// The client-side leg: a real third-party KISS client dials OUR KISS server. Direwolf's `kissutil` (shipped in
// Ubuntu's direwolf package, run inside the dw-b container) connects to the acs ingest's KISS server, which shares
// the ingest's KISS TNC (dw-a).
//   RX: a frame keyed on dw-b over AGWPE is modulated as AFSK, demodulated by dw-a, read by the acs ingest over
//       KISS TCP, and served by its KISS server: kissutil must print it.
//   TX off (the default): a frame kissutil sends must never reach the air, so dw-b must never hear it, and the
//       ingest must log the refusal.
// Runs after direwolf-loop.mjs in the same compose project, under tsx:
//   pnpm -C apps/ingest exec tsx ../../tools/interop/tests/kiss-server-loop.mjs
import { spawn, execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AgwpeTnc } from "../../../apps/ingest/src/agwpe.js";

const HOST = process.env.DW_HOST ?? "127.0.0.1";
const AGW_PORT = Number(process.env.DW_B_AGW_PORT ?? 38000);
// the driver runs from apps/ingest, so the compose file is found from this script's own directory
const COMPOSE_FILE = join(dirname(fileURLToPath(import.meta.url)), "../direwolf/docker-compose.yml");
const COMPOSE = ["compose", "-p", "direwolf", "-f", COMPOSE_FILE];
const TOCALL = "APZACG";
const run = Date.now().toString(36);

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

// kissutil in dw-b, dialling the acs ingest's KISS server across the compose network
const printed = [];
const kissutil = spawn("docker", [...COMPOSE, "exec", "-T", "dw-b", "kissutil", "-h", "acs", "-p", "8101"], {
  stdio: ["pipe", "pipe", "pipe"],
});
let out = "";
const take = (chunk) => {
  out += chunk.toString("latin1");
  let i;
  while ((i = out.indexOf("\n")) >= 0) {
    printed.push(out.slice(0, i).replace(/\r$/, ""));
    out = out.slice(i + 1);
  }
};
kissutil.stdout.on("data", take);
kissutil.stderr.on("data", take);

const heardOnAgw = [];
const agw = new AgwpeTnc(
  { host: HOST, port: AGW_PORT, retryMs: 1000 },
  { onPacket: () => {}, onFrame: (f) => heardOnAgw.push(f) },
);
agw.start();

// ---- RX: dw-b -> AFSK -> dw-a -> acs ingest -> KISS server -> kissutil ----
const rx = { src: "OE1KSV-3", dst: TOCALL, path: ["WIDE1-1"], payload: `>kiss server rx ${run}` };
const seen = await until(60000, async () => {
  const line = printed.find((l) => l.includes(rx.payload));
  if (line) return line;
  agw.send(rx);
  return await until(8000, async () => printed.find((l) => l.includes(rx.payload)));
});
ok(
  "kissutil, a KISS client of the acs ingest's server, prints a frame the ingest's TNC heard",
  !!seen && seen.includes(`${rx.src}>${TOCALL}`),
  `kissutil printed: ${JSON.stringify(printed.slice(-20))}`,
);

// ---- TX off: a frame kissutil sends never reaches the air ----
const tx = `OE1KUT-1>${TOCALL}:>kiss server tx ${run}`;
kissutil.stdin.write(`${tx}\n`);
await sleep(15000);
ok(
  "with KISS_SERVER_TX unset, a frame kissutil sends is not transmitted (dw-b never hears it)",
  !heardOnAgw.some((f) => f.payload.includes(`kiss server tx ${run}`)),
  "dw-b decoded it",
);
const logs = execFileSync("docker", [...COMPOSE, "logs", "acs"], { encoding: "utf8" });
ok(
  "the ingest logs the refused client frame",
  /\[kiss-server\].*transmit through the server is off/.test(logs),
  logs
    .split("\n")
    .filter((l) => l.includes("[kiss-server]"))
    .join("\n"),
);

kissutil.kill();
agw.stop();
console.log(failures ? `\nKISS SERVER CLIENT LEG FAILED (${failures})` : "\nKISS SERVER CLIENT LEG PASSED");
process.exit(failures ? 1 : 0);
