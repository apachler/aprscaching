// SPDX-License-Identifier: AGPL-3.0-or-later
import type { SqlDatabase, TileArchive, MediaStore, RoomNamespace } from "./runtime.js";
import { keysOf, parseOriginList, validateConfig, type ConfigKeysOf, type ConfigProblem } from "@aprscaching/shared";

/**
 * Every string setting the gateway reads comes from the configuration schema (packages/shared config.ts):
 * the Env type is derived from it and the self-host servers (Node, Bun, the desktop launcher) forward
 * exactly these keys from the process environment (stringEnvFrom). A setting added to the schema with the
 * `gateway` unit is live on every runtime; one not listed there is not a setting. Absent ⇒ the documented
 * default (docs/reference/configuration.md). INGEST_SECRET is typed apart below, because every runtime
 * requires it.
 */
type GatewayStringKey = Exclude<ConfigKeysOf<"gateway">, "INGEST_SECRET">;
const ENV_STRING_KEYS = keysOf("gateway").filter((k): k is GatewayStringKey => k !== "INGEST_SECRET");

/** Bindings the gateway needs, in runtime-neutral terms (see runtime.ts), plus every string setting. */
export type Env = {
  DB: SqlDatabase;
  TILES?: TileArchive; // the offline map archive (tiles.ts); absent when the operator provides none
  MEDIA?: MediaStore; // cache media and audio clues (the server's filesystem); optional
  ROOMS: RoomNamespace;
  // The ingest-plane credential: the ingest box presents it (x-ingest-secret) to post packets, drain the
  // outbox, carry BBS mail for the packet BBS, mirror the node table, log finds heard over APRS and poll remote commands.
  // It authorises nothing operator-level and never signs a session.
  INGEST_SECRET: string;
  /** Installed by Node/Bun: refuses federation fetches to private networks. */
  FED_FETCH_GUARD?: import("./fetchguard.js").FetchGuard;
  /**
   * Installed by Node/Bun: refuses tool-registry fetches to private networks, with none of the federation
   * guard's exceptions (operator origins, FED_ALLOW_PRIVATE, mDNS instances).
   */
  TOOL_FETCH_GUARD?: import("./fetchguard.js").FetchGuard;
  /** Installed by the Node server while its https listener runs: that listener's port (visitor.ts). */
  HTTPS_LISTENER_PORT?: string;
  /** Installed by the desktop launcher: this gateway is the desktop app, which updates by replacing its binary. */
  DESKTOP_APP?: true;
} & { [K in GatewayStringKey]?: string };

/** An on/off setting is on for 1, true or yes; unset, 0, false and no leave it off. */
export const flagOn = (v: string | undefined): boolean => v === "1" || v === "true" || v === "yes";

/**
 * The malformed settings of a gateway environment (a whole number that is not one, an unknown value of a
 * fixed set, JSON that does not parse). The Node and Bun servers refuse to start on any; the Setup
 * checklist reports the same check.
 */
export function configProblems(env: Partial<Env> | Record<string, unknown>): ConfigProblem[] {
  const src: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) if (typeof v === "string") src[k] = v;
  return validateConfig(src, "gateway");
}

/** Build the string-config slice of Env from a process.env-like record (undefined keys omitted). */
export function stringEnvFrom(src: Record<string, string | undefined>): Partial<Env> {
  const out: Record<string, string> = {};
  for (const k of ENV_STRING_KEYS) {
    const v = src[k];
    if (v !== undefined) out[k] = v;
  }
  return out;
}

const blank = (v: string | undefined): boolean => typeof v !== "string" || v.trim() === "";

/**
 * Fill the settings that follow from APP_URL: INSTANCE and RP_ID default to its hostname, so an operator
 * configures one public URL instead of three strings that must agree. A passkey needs a secure page, so when
 * APP_URL is plain http on a network host (a HAMNET main address) RP_ID follows the first https address in
 * EXTRA_ORIGINS instead, where passkeys work and where browsers fetch the related-origins file. An explicit value always wins; a
 * blank one (compose passes `${VAR:-}`) counts as unset. Without a parseable APP_URL both stay unset,
 * which keeps their own fallbacks (the request host; passkeys closed). Idempotent: it fills `env` in place
 * so per-env caches keyed on the object stay valid, and returns it.
 */
export function applyDerivedDefaults(env: Env): Env {
  if (!blank(env.INSTANCE) && !blank(env.RP_ID)) return env;
  let host: string | null;
  try {
    host = blank(env.APP_URL) ? null : new URL(env.APP_URL as string).hostname || null;
  } catch {
    host = null;
  }
  if (blank(env.INSTANCE)) env.INSTANCE = host ?? undefined;
  if (blank(env.RP_ID)) env.RP_ID = passkeyHost(env, host) ?? undefined;
  return env;
}

/** The default relying-party host: APP_URL's when it is a secure page, else the first https EXTRA_ORIGINS entry's. */
function passkeyHost(env: Env, appHost: string | null): string | null {
  let secureApp = false;
  try {
    const u = new URL(env.APP_URL as string);
    secureApp = u.protocol === "https:" || ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  } catch {
    /* no APP_URL: nothing secure there */
  }
  if (secureApp || !appHost) return appHost;
  const https = parseOriginList(env.EXTRA_ORIGINS).origins.find((o) => o.startsWith("https://"));
  return https ? new URL(https).hostname : appHost;
}

/**
 * The host this instance is reached at: APP_URL's hostname, else INSTANCE when it is a hostname. Text the
 * instance sends under its own name (a find announced on APRS-IS, the web-push contact) uses it, so each
 * instance names itself and never another.
 */
export function instanceHost(env: Env): string | null {
  try {
    if (!blank(env.APP_URL)) {
      const h = new URL(env.APP_URL as string).hostname;
      if (h) return h;
    }
  } catch {
    /* an unparseable APP_URL falls through to INSTANCE */
  }
  const inst = env.INSTANCE?.trim().toLowerCase() ?? "";
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(inst) ? inst : null;
}
