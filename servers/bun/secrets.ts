// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Self-host secrets resolved at boot. An operator-set value wins; it must be strong, and the session
 * secret must differ from the machine credentials (INGEST_SECRET, OPERATOR_SECRET), or whoever holds
 * those could mint sessions. An unset secret is generated once (32 random bytes) and kept owner-only in
 * `<name>.secret` beside the database, so a single box works with no setup and keeps its secrets across
 * restarts. Deleting `session.secret` ends every session on the next start.
 *
 * The Node server resolves SESSION_SECRET this way; the desktop app resolves all three, so it never runs
 * on a public default. `servers/bun/secrets.ts` is a byte-identical copy (a test keeps them equal).
 */
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";

export type ResolvedSecret =
  { ok: true; secret: string; source: "env" | "file" | "generated" } | { ok: false; error: string };

const weak = (s: string | undefined) => !s || s === "change-me";

/** `SESSION_SECRET` → `session.secret`. */
export const secretFile = (name: string) => `${name.toLowerCase().replace(/_secret$/, "")}.secret`;

/** Resolve one secret: the env value, else the kept file, else a freshly generated one (then kept). */
export function resolveSecret(
  name: string,
  env: Record<string, string | undefined>,
  dataDir: string,
  distinctFrom: Array<string | undefined> = [],
): ResolvedSecret {
  const others = distinctFrom.filter((s): s is string => !!s);
  const distinct = (s: string) => !others.includes(s);
  const set = env[name];
  if (set !== undefined && set !== "") {
    if (weak(set)) return { ok: false, error: `${name} is the 'change-me' default — set a strong value` };
    if (!distinct(set)) return { ok: false, error: `${name} must differ from the other instance secrets` };
    return { ok: true, secret: set, source: "env" };
  }
  const file = path.join(dataDir, secretFile(name));
  try {
    const kept = fs.readFileSync(file, "utf8").trim();
    if (!weak(kept) && distinct(kept)) return { ok: true, secret: kept, source: "file" };
  } catch {
    /* none kept yet */
  }
  const secret = randomBytes(32).toString("base64url");
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(file, secret + "\n", { mode: 0o600 });
    fs.chmodSync(file, 0o600);
  } catch (e) {
    return {
      ok: false,
      error: `${name} is unset and ${file} could not be written (${(e as Error).message}) — set ${name}`,
    };
  }
  return { ok: true, secret, source: "generated" };
}

/** SESSION_SECRET for a self-host server: never equal to the ingest or operator secret. */
export function resolveSessionSecret(env: Record<string, string | undefined>, dataDir: string): ResolvedSecret {
  return resolveSecret("SESSION_SECRET", env, dataDir, [env.INGEST_SECRET, env.OPERATOR_SECRET]);
}

export interface InstanceSecrets {
  INGEST_SECRET: string;
  OPERATOR_SECRET: string;
  SESSION_SECRET: string;
}

/** All three secrets for a single-user instance (the desktop app): each from env, the kept file, or new. */
export function resolveInstanceSecrets(
  env: Record<string, string | undefined>,
  dataDir: string,
): { ok: true; secrets: InstanceSecrets } | { ok: false; error: string } {
  const ingest = resolveSecret("INGEST_SECRET", env, dataDir);
  if (!ingest.ok) return ingest;
  const operator = resolveSecret("OPERATOR_SECRET", env, dataDir, [ingest.secret]);
  if (!operator.ok) return operator;
  const session = resolveSecret("SESSION_SECRET", env, dataDir, [ingest.secret, operator.secret]);
  if (!session.ok) return session;
  return {
    ok: true,
    secrets: { INGEST_SECRET: ingest.secret, OPERATOR_SECRET: operator.secret, SESSION_SECRET: session.secret },
  };
}
