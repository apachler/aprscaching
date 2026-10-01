// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Ask the gateway whether it accepts this box's credential, the way the box itself sends it: signed with its
 * key when it is enrolled, else with the shared secret. Prints the HTTP status and the gateway's answer on
 * one line (`200 {"ok":true,…}`), for `deploy/aprscaching doctor`.
 *
 *   node --import tsx src/check.ts
 */
import { loadDotEnv } from "./config.js";
import { gatewayFetch, loadBoxKey, useBoxKey } from "./gatewayauth.js";

loadDotEnv();
const env = process.env;
const url = `${(env.INGEST_URL ?? "http://127.0.0.1:8787/ingest").replace(/\/+$/, "")}/check`;
try {
  useBoxKey(loadBoxKey(env));
  const res = await gatewayFetch(url, { headers: { "x-ingest-secret": env.INGEST_SECRET ?? "" } });
  process.stdout.write(`${res.status} ${(await res.text()).replace(/\s+/g, " ").slice(0, 500)}\n`);
} catch (e) {
  process.stdout.write(`0 ${(e as Error).message}\n`);
}
