// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * What the box says in its log when a feature it is set up for gets nothing from the gateway. The gateway pairs,
 * polls and answers through a box only by the box's own signature, and serves BBS mail only to an enrolled box
 * the sysop lets run this instance's services; the shared INGEST_SECRET posts packets and nothing more. Each of
 * these fails without an error on the box's side, so the box names the cause and the fix.
 */

type Env = Record<string, string | undefined>;

const ENROLL = "enroll it with a one-time code from Instance admin → Ingest boxes (deploy/aprscaching init ingest-box)";

/** BOX_ID without BOX_KEY: no remote control, and no radio replies or Mailbox messages through this box. */
export function boxKeyWarning(env: Env): string | null {
  if (!env.BOX_ID || env.BOX_KEY) return null;
  return `[box] remote control and radio replies are off: BOX_ID is set, but the box has no key of its own (BOX_KEY). The gateway pairs, polls and answers through only an enrolled box: ${ENROLL}`;
}

/**
 * The packet BBS or FBB forwarding set up where the gateway serves it no mail: the box has no key of its own, or
 * (`services` false, as the gateway's `/ingest/check` reports it for the box's signed request) the sysop has not
 * switched on Runs this instance's services. `services` undefined is not known yet, and warns of nothing.
 */
export function bbsWarning(env: Env, services?: boolean | null): string | null {
  if (!(env.BBS_NODE_CALL || env.BBS_FORWARD === "1")) return null;
  const head = "[bbs] the packet BBS and FBB forwarding answer no mail:";
  if (!env.BOX_KEY)
    return `${head} the box has no key of its own (BOX_KEY), and the gateway serves mail only to an enrolled box that runs this instance's services. ${ENROLL[0]!.toUpperCase()}${ENROLL.slice(1)}, then switch on Runs this instance's services`;
  if (services === false)
    return `${head} the gateway serves mail only to an enrolled box that runs this instance's services, and this box does not. Switch on Runs this instance's services for ${env.BOX_ID ?? "this box"} in Instance admin → Ingest boxes`;
  return null;
}

/**
 * Print, at the box's start, what the box knows on its own settings: BOX_ID without a key, and a packet BBS or FBB
 * forwarding on a box with no key. The start path calls this and nothing else prints these.
 */
export function warnAtStart(env: Env, warn: (line: string) => void = console.warn): void {
  for (const w of [bbsWarning(env), boxKeyWarning(env)]) if (w) warn(w);
}

/**
 * Print, once per distinct text, what the gateway's `/ingest/check` answer tells a keyed box: a packet BBS or FBB
 * forwarding whose services the sysop has not switched on. The answer is read every 15 minutes; `warned` keeps
 * the log to one line per cause.
 */
export function warnOnCheck(
  env: Env,
  services: boolean | null | undefined,
  warned: Set<string>,
  warn: (line: string) => void = console.warn,
): void {
  if (!env.BOX_KEY) return; // an unkeyed box was told at start
  const w = bbsWarning(env, services);
  if (w && !warned.has(w)) {
    warned.add(w);
    warn(w);
  }
}
