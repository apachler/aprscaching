// SPDX-License-Identifier: AGPL-3.0-or-later
// Every copy of the offline map archive a tile answer opens is closed, whatever the client does: it reads the whole
// answer, leaves mid-answer, stops reading, asks for a range past the end, or leaves before the answer is ready. A
// copy left open holds a file descriptor until garbage collection, where Node closes it and reports the leak — as an
// uncaught exception on recent Node, which the gateway's stray-error logger prints.
import { afterEach, expect, it } from "vitest";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import v8 from "node:v8";
import vm from "node:vm";
import type { AddressInfo } from "node:net";
import { RoomsCore } from "@aprscaching/gateway/rooms-core";
import { instanceEnv } from "./helpers/fedpeer.js";
import { createGatewayServer } from "../src/listen.js";
import { fileTiles } from "../src/tiles.js";

const servers: http.Server[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    await new Promise((r) => s.close(r));
  }
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Node's collector, reachable without --expose-gc on the test process. */
function collectGarbage(): void {
  v8.setFlagsFromString("--expose-gc");
  (vm.runInNewContext("gc") as () => void)();
}

it("every opened archive copy is closed, including for a client gone before the answer was ready", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "acs-tile-handles-"));
  dirs.push(dir);
  const file = path.join(dir, "offline.pmtiles");
  fs.writeFileSync(file, Buffer.alloc(16 * 1024 * 1024, 7));
  const real = fileTiles(file)!;
  let opened = 0;
  let closed = 0;
  let openDelay = 0;
  const TILES = {
    stat: real.stat,
    open: async () => {
      const r = (await real.open())!;
      opened++;
      if (openDelay) await sleep(openDelay);
      return { ...r, close: () => (closed++, r.close()) };
    },
  };
  const server = createGatewayServer({
    env: instanceEnv("gw.test", null, { TILES }),
    rooms: new RoomsCore(),
    writeStallMs: 300,
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  const get = (range: string, act: (s: net.Socket) => void) => {
    const s = net.connect(port, "127.0.0.1", () => {
      s.write(`GET /tiles/offline.pmtiles HTTP/1.1\r\nHost: gw.test\r\nRange: ${range}\r\n\r\n`);
      act(s);
    });
    s.on("error", () => {});
  };

  const uncaught: unknown[] = [];
  const onUncaught = (e: unknown) => uncaught.push(e);
  const leakWarnings: string[] = [];
  const onWarning = (w: Error) => {
    if (/file descriptor/i.test(w.message)) leakWarnings.push(w.message);
  };
  process.on("uncaughtException", onUncaught);
  process.on("warning", onWarning);
  const steps: string[] = [];
  const step = (name: string) => steps.push(`${name}: opened ${opened}, closed ${closed}`);
  try {
    get("bytes=0-", (s) => s.on("data", () => {}));
    await sleep(500);
    step("full read");
    get("bytes=0-", (s) => s.once("data", () => s.destroy()));
    await sleep(500);
    step("gone mid-answer");
    get("bytes=0-", (s) => s.pause());
    await sleep(1500);
    step("never reads");
    get("bytes=99999999-", (s) => s.on("data", () => {}));
    await sleep(300);
    step("range past the end");
    // the archive opens 300 ms after the request; the client leaves at 50 ms, before any answer exists
    openDelay = 300;
    get("bytes=0-", (s) => setTimeout(() => s.destroy(), 50));
    await sleep(1000);
    step("gone before the answer was ready");
    openDelay = 0;
    // a copy nobody closed is closed by the collector, which is where Node reports it
    collectGarbage();
    await sleep(200);
    collectGarbage();
    await sleep(200);
  } finally {
    process.off("uncaughtException", onUncaught);
    process.off("warning", onWarning);
  }
  expect
    .soft(steps)
    .toEqual([
      "full read: opened 1, closed 1",
      "gone mid-answer: opened 2, closed 2",
      "never reads: opened 3, closed 3",
      "range past the end: opened 4, closed 4",
      "gone before the answer was ready: opened 5, closed 5",
    ]);
  expect.soft(uncaught).toEqual([]);
  expect.soft(leakWarnings).toEqual([]);
}, 30_000);
