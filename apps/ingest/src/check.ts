// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The box's self-checks, for `deploy/aprscaching doctor` and the operator.
 *
 *   node --import tsx src/check.ts                  the credential: does the gateway accept it, sent the way the
 *                                                   box sends it (signed with its key when enrolled, else the
 *                                                   shared secret)? Prints the HTTP status and the gateway's
 *                                                   answer on one line (`200 {"ok":true,…}`).
 *   node --import tsx src/check.ts --soundcard      the soundcard ports: one tab-separated line per check
 *                                                   (kind, port, status, message, fix). Never keys the radio.
 *   node --import tsx src/check.ts --ptt-test [port]  key one port's PTT for half a second, with no audio; refused
 *                                                   unless its transmit is on, the gateway confirms its station
 *                                                   calls and a second of listening hears a clear channel. Run it
 *                                                   with the ingest stopped: the running box owns the card.
 */
import { gatewayUrls, loadDotEnv } from "./config.js";
import { gatewayFetch, loadBoxKey, useBoxKey } from "./gatewayauth.js";

loadDotEnv();
const env = process.env;
const { ingest } = gatewayUrls(env.INGEST_URL);
const args = process.argv.slice(2);
const flat = (s: string) => s.replace(/[\t\n]/g, " ");

try {
  useBoxKey(loadBoxKey(env));
} catch (e) {
  if (!args.length) {
    process.stdout.write(`0 ${(e as Error).message}\n`);
    process.exit(0);
  }
}

if (args[0] === "--soundcard" || args[0] === "--ptt-test") {
  const { soundcardChecks, pttTest } = await import("./soundcardcheck.js");
  const { gatewayTxGateLookup } = await import("./callverify.js");
  const deps = {
    gate: gatewayTxGateLookup({
      ingestUrl: ingest,
      secret: env.INGEST_SECRET ?? "",
      boxKey: !!env.BOX_KEY,
      boxId: env.BOX_ID || undefined,
    }),
  };
  if (args[0] === "--soundcard") {
    for (const r of await soundcardChecks(env, deps))
      process.stdout.write(`${[r.kind, r.port || "-", r.status, flat(r.message), flat(r.fix)].join("\t")}\n`);
  } else {
    try {
      const r = await pttTest(env, args[1], deps);
      process.stdout.write(`${r.message}\n`);
      process.exitCode = r.ok ? 0 : 1;
    } catch (e) {
      process.stdout.write(`PTT test failed: ${(e as Error).message}\n`);
      process.exitCode = 1;
    }
  }
} else {
  try {
    const res = await gatewayFetch(`${ingest}/check`, { headers: { "x-ingest-secret": env.INGEST_SECRET ?? "" } });
    process.stdout.write(`${res.status} ${(await res.text()).replace(/\s+/g, " ").slice(0, 500)}\n`);
  } catch (e) {
    process.stdout.write(`0 ${(e as Error).message}\n`);
  }
}
