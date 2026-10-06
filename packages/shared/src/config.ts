// SPDX-License-Identifier: MIT
/**
 * The configuration schema: every environment key a unit of this project reads, with its type, default,
 * the units that read it and whether it is a secret. It is the single source of truth — the gateway's Env
 * type and the key list the Node/Bun servers forward derive from it, the ingest box validates its
 * environment against it, the deploy helpers read its JSON/TSV export, and the key tables of
 * docs/reference/configuration.md and both `.env.example` files are generated from it
 * (tools/config/generate.mjs). The one-line hints and the documentation tables live in configdocs.ts, so
 * a runtime that only validates does not carry the prose.
 */
import { z } from "zod";
import { CONFIG_KEYS } from "./configkeys.js";
import { parseOriginList } from "./origins.js";

export { CONFIG_KEYS };

/**
 * Who reads a key: the gateway app on every runtime (`gateway`), the Node/Bun server process around it
 * (`server`), the desktop launcher (`desktop`), the ingest box (`ingest`), the web build (`web`), the
 * deploy scripts and compose files (`deploy`), the Pocket scripts (`pocket`) and the licence-register
 * importer (`licence`).
 */
export type ConfigUnit = "gateway" | "server" | "desktop" | "ingest" | "web" | "deploy" | "pocket" | "licence";

/** The deployment shapes the helpers set up; which keys apply to one follows from its units. */
export type ConfigShape = "selfhost" | "baremetal" | "ingest-box" | "pocket" | "desktop";

/**
 * Value types. `int` and `number` are what the code parses with Number(); `enum` takes one of `values`
 * exactly; `list` is comma-separated; `json` must parse; `url` must parse as an absolute URL; `call` is one
 * callsign an AX.25 station can transmit under (a base of up to six letters and digits with a digit in it,
 * and an optional SSID 0–15); `calls` is a comma- or space-separated list of callsigns, whose SSID may run
 * to 99 as a MeshCom node's does; `origins` is a comma- or space-separated list of bare http(s) origins
 * (origins.ts); `string` takes anything (including the keys that switch a feature on by
 * being set at all).
 */
export type ConfigType = "string" | "int" | "number" | "enum" | "list" | "json" | "url" | "call" | "calls" | "origins";

export interface ConfigKey {
  readonly type: ConfigType;
  readonly units: readonly ConfigUnit[];
  /** The machine default the code falls back to, when it is a literal; absent when computed or none. */
  readonly default?: string;
  /** The accepted values of an `enum`. */
  readonly values?: readonly string[];
  /** A secret: never printed, never logged, stored owner-only. */
  readonly secret?: boolean;
  /** A public instance must set it (the Setup checklist and `doctor` flag it when missing). */
  readonly publicRequired?: boolean;
  /** The shapes it applies to, when that is narrower than its units imply. */
  readonly shapes?: readonly ConfigShape[];
  /** A site setting: a sysop may also set it in Instance admin → Instance settings (sitesettings.ts). */
  readonly site?: SiteSetting;
}

/** The groups of Instance admin → Instance settings, in display order. */
export const SITE_GROUPS = [
  "game",
  "accounts",
  "retention",
  "imports",
  "federation",
  "tools",
  "imprint",
  "support",
  "updates",
] as const;
export type SiteGroup = (typeof SITE_GROUPS)[number];

/**
 * A policy value the sysop tunes while the instance runs, stored in the database (`site_settings`). The
 * environment wins when it sets the key; otherwise the stored value applies, else the schema default. Only
 * a key the gateway reads afresh on each use is one: never a secret, an address, a key, a path or a port.
 * The value's type is the key's `type`; these fields narrow it.
 */
export interface SiteSetting {
  readonly group: SiteGroup;
  /** The bounds of an `int` or a `number`. */
  readonly min?: number;
  readonly max?: number;
  /** The unit a number is in, as the form shows it beside the field. */
  readonly unit?: string;
  /** The items a `list` may hold, when they are known ids. */
  readonly options?: readonly string[];
  /** The longest accepted text of a `string` (default 200 characters). */
  readonly maxLength?: number;
  /**
   * A value that needs more than its type: an email address, contact URIs (a bare address becomes
   * `mailto:`), donation links (`[{label,url}]`), or the retention fields (RETENTION_FIELDS).
   */
  readonly format?: "email" | "contacts" | "links" | "retention";
}

export type ConfigKeyName = keyof typeof CONFIG_KEYS;

/** The keys a unit reads, as a literal union. */
export type ConfigKeysOf<U extends ConfigUnit> = {
  [K in ConfigKeyName]: U extends (typeof CONFIG_KEYS)[K]["units"][number] ? K : never;
}[ConfigKeyName];

const ALL_SHAPES: readonly ConfigShape[] = ["selfhost", "baremetal", "ingest-box", "pocket", "desktop"];

/** The shapes a unit runs in. */
const UNIT_SHAPES: Record<ConfigUnit, readonly ConfigShape[]> = {
  gateway: ["selfhost", "baremetal", "pocket", "desktop"],
  server: ["selfhost", "baremetal", "pocket", "desktop"],
  desktop: ["desktop"],
  ingest: ["selfhost", "baremetal", "ingest-box", "pocket"],
  web: ["selfhost", "baremetal", "pocket"],
  deploy: ["selfhost", "ingest-box"],
  pocket: ["pocket"],
  licence: ALL_SHAPES,
};

/** The shapes a key applies to: its explicit list, else the union of its units' shapes. */
export function shapesOf(name: ConfigKeyName): readonly ConfigShape[] {
  const k: ConfigKey = CONFIG_KEYS[name];
  if (k.shapes) return k.shapes;
  const out = new Set<ConfigShape>();
  for (const u of k.units) for (const s of UNIT_SHAPES[u]) out.add(s);
  return ALL_SHAPES.filter((s) => out.has(s));
}

/** Every key a unit reads, in schema order. */
export function keysOf<U extends ConfigUnit>(unit: U): ConfigKeysOf<U>[] {
  return (Object.keys(CONFIG_KEYS) as ConfigKeyName[]).filter((k) =>
    (CONFIG_KEYS[k].units as readonly ConfigUnit[]).includes(unit),
  ) as ConfigKeysOf<U>[];
}

const finite = (v: string) => v.trim() !== "" && Number.isFinite(Number(v));

/** A callsign: a base of 1–6 letters and digits holding a digit, and an SSID up to `maxSsid`. */
const isCall = (c: string, maxSsid: number) => {
  const m = /^([A-Z0-9]{1,6})(?:-(\d{1,2}))?$/i.exec(c.trim());
  return !!m && /\d/.test(m[1]!) && (m[2] === undefined || Number(m[2]) <= maxSsid);
};

function validator(k: ConfigKey): z.ZodType<string> {
  const s = z.string();
  switch (k.type) {
    case "int":
      return s.refine((v) => finite(v) && Number.isInteger(Number(v)), "expected a whole number");
    case "number":
      return s.refine(finite, "expected a number");
    case "enum":
      return s.refine((v) => (k.values ?? []).includes(v), `expected one of: ${(k.values ?? []).join(", ")}`);
    case "json":
      return s.refine((v) => {
        try {
          JSON.parse(v);
          return true;
        } catch {
          return false;
        }
      }, "expected valid JSON");
    case "url":
      return s.refine((v) => URL.canParse(v.trim()), "expected an absolute URL");
    case "call":
      return s.refine((v) => isCall(v, 15), "expected a callsign such as OE8APR-10 (SSID 0-15)");
    case "calls":
      return s.refine(
        (v) =>
          v
            .split(/[\s,]+/)
            .filter(Boolean)
            .every((c) => isCall(c, 99)),
        "expected callsigns such as OE8APR,OE8APR-10, separated by commas",
      );
    case "origins":
      return s.refine(
        (v) => parseOriginList(v).invalid.length === 0,
        "expected origins such as https://aprs.example.net,http://44.143.1.2, separated by commas (no path)",
      );
    default:
      return s;
  }
}

/** Why `value` does not fit the type of `key`, or null when it does. */
export function configValueProblem(key: ConfigKeyName, value: string): string | null {
  const r = validator(CONFIG_KEYS[key]).safeParse(value);
  return r.success ? null : (r.error.issues[0]?.message ?? "invalid value");
}

export interface ConfigProblem {
  key: ConfigKeyName;
  message: string;
}

/**
 * Check the values the given units read from an environment-like record. A blank value counts as unset
 * (compose passes `${VAR:-}`), so only a value that is set and malformed is a problem. The message names
 * the key and what it expects, never the value — a malformed value may be a secret pasted into the wrong key.
 */
export function validateConfig(
  src: Record<string, string | undefined>,
  units: ConfigUnit | readonly ConfigUnit[],
): ConfigProblem[] {
  const out: ConfigProblem[] = [];
  const keys = new Set((typeof units === "string" ? [units] : units).flatMap((u) => keysOf(u)));
  for (const key of keys) {
    const v = src[key];
    if (v === undefined || v.trim() === "") continue;
    const r = validator(CONFIG_KEYS[key]).safeParse(v);
    if (!r.success) out.push({ key, message: `${key}: ${r.error.issues[0]?.message ?? "invalid value"}` });
  }
  return out;
}
