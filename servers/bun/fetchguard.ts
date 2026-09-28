// SPDX-License-Identifier: AGPL-3.0-or-later
/** The Bun binding of the federation fetch guard: resolve through the system resolver. */
import { lookup } from "node:dns/promises";
import { createFetchGuard, type FetchGuard } from "@aprscaching/gateway/fetchguard";

export function makeFetchGuard(opts: { allowedOrigins?: string[]; allowPrivate?: boolean } = {}): FetchGuard {
  return createFetchGuard({
    ...opts,
    resolve: async (host) => (await lookup(host, { all: true })).map((a) => a.address),
  });
}
