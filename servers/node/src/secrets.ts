// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Self-host secrets resolved at boot. An operator-set value wins; it must be strong, and the session
 * secret must differ from the machine credentials (INGEST_SECRET, OPERATOR_SECRET), or whoever holds
 * those could mint sessions. An unset secret is generated once (32 random bytes) and kept owner-only in
 * `<name>.secret` beside the database, so a single box works with no setup and keeps its secrets across
 * restarts. Deleting `session.secret` ends every session on the next start.
 *
 * The Node and Bun servers resolve SESSION_SECRET this way; the desktop app resolves all three, so it never
 * runs on a public default.
 */
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";

/** Where a resolved secret came from. */
export type SecretSource = "env" | "file" | "generated";

export type ResolvedSecret = { ok: true; secret: string; source: SecretSource } | { ok: false; error: string };

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

export interface ServerSecrets {
  INGEST_SECRET: string;
  OPERATOR_SECRET?: string;
  SESSION_SECRET: string;
}

/**
 * The secrets of a self-host server (Node or Bun). INGEST_SECRET is required: the ingest box
 * authenticates with it, and the known default would let anyone post packets and log finds as the
 * ingest plane. OPERATOR_SECRET is optional (unset closes the operator's machine paths), but a set value
 * must be strong and must not be the ingest secret — that would hand the ingest box operator rights.
 * SESSION_SECRET is resolved as {@link resolveSessionSecret} does. `error` is the operator-facing reason
 * the server refuses to start.
 */
export function resolveServerSecrets(
  env: Record<string, string | undefined>,
  dataDir: string,
): { ok: true; secrets: ServerSecrets; sessionSource: SecretSource } | { ok: false; error: string } {
  const ingest = env.INGEST_SECRET ?? "";
  if (!ingest || ingest === "change-me")
    return {
      ok: false,
      error:
        "INGEST_SECRET is unset or still the 'change-me' default.\n" +
        "  Set a strong secret, e.g.:  INGEST_SECRET=$(openssl rand -hex 24)",
    };
  const operator = env.OPERATOR_SECRET;
  if (operator !== undefined && operator !== "" && (operator === "change-me" || operator === ingest))
    return {
      ok: false,
      error:
        "OPERATOR_SECRET is the 'change-me' default or equal to INGEST_SECRET.\n" +
        "  Set its own strong value, e.g.:  OPERATOR_SECRET=$(openssl rand -hex 24)  (or leave it unset)",
    };
  const session = resolveSessionSecret(env, dataDir);
  if (!session.ok) return { ok: false, error: `${session.error}\n  e.g.:  SESSION_SECRET=$(openssl rand -hex 32)` };
  return {
    ok: true,
    secrets: { INGEST_SECRET: ingest, OPERATOR_SECRET: operator, SESSION_SECRET: session.secret },
    sessionSource: session.source,
  };
}
