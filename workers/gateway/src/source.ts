// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * source.ts — AGPL §13 "Source" link (ADR-3, docs/14). A network user of the running instance can
 * reach the exact source it is running. Runtime-neutral (Worker / Node / Bun); the host resolves the
 * commit (env or git) and passes SOURCE_* in Env. **Launch-blocking before the first public deploy.**
 *
 *   GET /.well-known/source   machine-readable {repo, commit, tag, builtAt, license}
 *   GET /source               302 → the repo tree at the running commit
 *
 * Self-hosters who MODIFY the code MUST set SOURCE_REPO (and SOURCE_COMMIT) to *their* published fork.
 */
import type { Env } from "./env.js";
import { json } from "./app.js";

const UPSTREAM_REPO = "https://github.com/apachler/aprscaching";

export function sourceInfo(env: Env): {
  repo: string; commit: string | null; tag: string | null; builtAt: number | null; license: string;
} {
  return {
    repo: (env.SOURCE_REPO ?? UPSTREAM_REPO).replace(/\/+$/, ""),
    commit: env.SOURCE_COMMIT ?? null,
    tag: env.SOURCE_TAG ?? null,
    builtAt: env.SOURCE_BUILT_AT ? (Number(env.SOURCE_BUILT_AT) || null) : null,
    license: "AGPL-3.0-or-later",
  };
}

/** GET /.well-known/source — the descriptor of the source the instance is running. */
export function handleWellKnownSource(_req: Request, env: Env): Response {
  return json({ protocol: "aprscaching-source/1", ...sourceInfo(env) });
}

/** GET /source — redirect to the exact source tree the instance is running (or repo root if unknown). */
export function handleSourceRedirect(_req: Request, env: Env): Response {
  const { repo, commit } = sourceInfo(env);
  const location = commit ? `${repo}/tree/${encodeURIComponent(commit)}` : repo;
  return new Response(null, { status: 302, headers: { location } });
}
