// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * PTT through Hamlib's `rigctld`: `T 1` keys, `T 0` unkeys, each answered `RPRT 0`. rigctld drives the
 * radio's CAT (or its own PTT setting), so this covers the many rigs Hamlib supports. The daemon runs as its
 * own process; the box only speaks its TCP text protocol (`packages/aprs/src/rigctld.ts`).
 *
 * One command is in flight at a time, and a reply belongs to the command on its connection: a command that
 * times out closes the connection, so a late `RPRT` can never answer the next command. A lost connection is
 * opened again on the next command, after a backoff. A closed connection does not unkey the radio, and there
 * is no synchronous path at process exit, so the radio's own transmit time-out must be on.
 */
import net from "node:net";
import { RigctldClient } from "@aprscaching/aprs";
import { Backoff } from "../backoff.js";
import type { Ptt } from "./types.js";

/** How long one command may wait for its answer, and a connection for its handshake. */
const REPLY_MS = 2000;

export async function openRigctldPtt(
  o: { host: string; port: number },
  deps: { replyMs?: number; backoff?: Backoff } = {},
): Promise<Ptt> {
  const replyMs = deps.replyMs ?? REPLY_MS;
  const backoff = deps.backoff ?? new Backoff({ baseMs: 500, capMs: 10_000 });
  const where = `rigctld ${o.host}:${o.port}`;
  let sock: net.Socket | null = null;
  let notBefore = 0; // no reconnect before this time, after a failure
  let closed = false;

  const connect = () =>
    new Promise<net.Socket>((res, rej) => {
      const s = net.connect(o.port, o.host);
      s.setNoDelay(true);
      s.setEncoding("utf8");
      const t = setTimeout(() => {
        s.destroy();
        rej(new Error(`${where} does not answer`));
      }, replyMs);
      s.once("connect", () => {
        clearTimeout(t);
        s.on("error", (e) => console.error(`[ptt] ${where}: ${e.message}`));
        res(s);
      });
      s.once("error", (e) => {
        clearTimeout(t);
        rej(new Error(`${where} does not answer: ${e.message}`));
      });
    });

  /** The open connection, opened again when it was lost (no sooner than the backoff allows). */
  const ensure = async (): Promise<net.Socket> => {
    if (sock && !sock.destroyed) return sock;
    if (closed) throw new Error(`${where} is closed`);
    const wait = notBefore - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, Math.min(wait, replyMs)));
    try {
      sock = await connect();
      backoff.reset();
      return sock;
    } catch (e) {
      notBefore = Date.now() + backoff.next();
      throw e;
    }
  };

  /** Send one line and wait for its `RPRT`; any failure drops the connection, so no reply is left over. */
  const exchange = async (line: string): Promise<string> => {
    const s = await ensure();
    return new Promise<string>((resolve, reject) => {
      let buf = "";
      const finish = (e: Error | null, reply?: string) => {
        clearTimeout(t);
        s.off("data", onData);
        s.off("close", onClose);
        if (e) {
          s.destroy(); // a late reply dies with the connection
          if (sock === s) sock = null;
          reject(e);
        } else resolve(reply!);
      };
      const onData = (chunk: string) => {
        buf += chunk;
        if (/RPRT\s+-?\d+\s*\n/.test(buf)) finish(null, buf);
      };
      const onClose = () => finish(new Error(`${where} closed the connection`));
      const t = setTimeout(() => finish(new Error(`${where} did not answer within ${replyMs} ms`)), replyMs);
      s.on("data", onData);
      s.on("close", onClose);
      s.write(line);
    });
  };

  let chain: Promise<unknown> = Promise.resolve();
  const client = new RigctldClient({
    send: (line) => {
      const run = chain.then(
        () => exchange(line),
        () => exchange(line),
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
    (sock as net.Socket | null)?.destroy();
    throw e;
  }
  return {
    label: where,
    key: () => ptt(true),
    unkey: () => ptt(false),
    close: async () => {
      await ptt(false).catch(() => {});
      closed = true;
      sock?.end();
      sock?.destroy();
    },
  };
}
