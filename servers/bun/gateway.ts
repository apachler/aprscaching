// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Re-export of the runtime-neutral gateway surface, resolved from this package's node_modules
 * (servers/bun depends on @aprsweb/gateway). Lets the desktop launcher (deploy/desktop/, which has
 * no workspace node_modules of its own) reach handle()/Env/LiveEnvelope without a bare specifier it
 * can't resolve — both in dev (`bun run`) and under `bun build --compile`.
 */
export { handle, runScheduled, syncAllPeers } from "@aprsweb/gateway/app";
export type { Env } from "@aprsweb/gateway/env";
export type { LiveEnvelope } from "@aprsweb/gateway/live";
