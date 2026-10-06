// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * PTT through Hamlib's `rigctld`: `T 1` keys, `T 0` unkeys, each answered `RPRT 0`. rigctld drives the
 * radio's CAT (or its own PTT setting), so this covers the many rigs Hamlib supports. The daemon runs as its
 * own process; the box only speaks its TCP text protocol (`packages/aprs/src/rigctld.ts`). A closed
 * connection does not unkey the radio, so set the radio's own transmit time-out as well.
 */
import net from "node:net";
import { RigctldClient } from "@aprscaching/aprs";
import type { Ptt } from "./types.js";

/** How long one command may wait for its answer. */
const REPLY_MS = 3000;

export async function openRigctldPtt(o: { host: string; port: number }): Promise<Ptt> {
  const sock = net.connect(o.port, o.host);
  sock.setNoDelay(true);
  await new Promise<void>((res, rej) => {
    sock.once("connect", () => res());
    sock.once("error", (e) => rej(new Error(`rigctld ${o.host}:${o.port} does not answer: ${e.message}`)));
  });
  sock.on("error", (e) => console.error(`[ptt] rigctld ${o.host}:${o.port}: ${e.message}`));
  let buf = "";
  let waiting: { resolve: (s: string) => void; reject: (e: Error) => void } | null = null;
  sock.setEncoding("utf8");
  sock.on("data", (chunk: string) => {
    buf += chunk;
    // a set command's reply ends with its `RPRT <code>` line
    if (waiting && /RPRT\s+-?\d+\s*\n/.test(buf)) {
      const w = waiting;
      waiting = null;
      const reply = buf;
      buf = "";
      w.resolve(reply);
    }
  });
  sock.on("close", () => waiting?.reject(new Error("rigctld closed the connection")));
  // one command at a time: the protocol answers in order, and PTT never needs two in flight
  let chain: Promise<unknown> = Promise.resolve();
  const client = new RigctldClient({
    send: (line) => {
      const run = chain.then(
        () =>
          new Promise<string>((resolve, reject) => {
            if (sock.destroyed) return reject(new Error("rigctld connection is closed"));
            const t = setTimeout(() => {
              waiting = null;
              reject(new Error(`rigctld did not answer within ${REPLY_MS} ms`));
            }, REPLY_MS);
            waiting = {
              resolve: (s) => {
                clearTimeout(t);
                resolve(s);
              },
              reject: (e) => {
                clearTimeout(t);
                reject(e);
              },
            };
            sock.write(line);
          }),
      );
      chain = run.catch(() => {});
      return run;
    },
  });
  const ptt = async (on: boolean) => {
    const r = await client.setPtt(on);
    if (!r.ok) throw new Error(`rigctld refused T ${on ? 1 : 0} (RPRT ${r.code})`);
  };
  try {
    await ptt(false); // start from unkeyed, as every driver does
  } catch (e) {
    sock.destroy();
    throw e;
  }
  return {
    label: `rigctld ${o.host}:${o.port}`,
    key: () => ptt(true),
    unkey: () => ptt(false),
    close: async () => {
      await ptt(false).catch(() => {});
      sock.end();
      sock.destroy();
    },
  };
}
