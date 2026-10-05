// SPDX-License-Identifier: MIT
/**
 * Site settings: the policy values a sysop tunes while the instance runs, edited in Instance admin → Instance
 * settings and stored in the database. Infrastructure and secrets stay in the environment. The precedence is
 * one rule, so each setting has exactly one visible source: a key the environment sets wins (and the page shows
 * it read-only), else the stored value applies, else the schema default. Which keys are site settings, and how
 * far each may go, is the `site` field of the configuration schema (configkeys.ts); this module checks and
 * normalises a value a sysop submits, for the gateway and for the form alike.
 */
import { CONFIG_KEYS, configValueProblem, type ConfigKey, type ConfigKeyName, type SiteSetting } from "./config.js";

/** A key of the schema that is a site setting. */
export type SiteSettingKey = {
  [K in ConfigKeyName]: (typeof CONFIG_KEYS)[K] extends { site: SiteSetting } ? K : never;
}[ConfigKeyName];

/** Every site setting, in schema order. */
export const SITE_SETTING_KEYS = (Object.keys(CONFIG_KEYS) as ConfigKeyName[]).filter(
  (k) => (CONFIG_KEYS[k] as ConfigKey).site !== undefined,
) as SiteSettingKey[];

export const isSiteSettingKey = (k: string): k is SiteSettingKey =>
  (SITE_SETTING_KEYS as readonly string[]).includes(k);

/** An on/off setting: an enum of the flag spellings, which the form shows as a switch and writes as 1 or 0. */
export const isFlagKey = (k: ConfigKeyName): boolean => {
  const v = (CONFIG_KEYS[k] as ConfigKey).values;
  return !!v && v.includes("0") && v.includes("1");
};

/**
 * The tables the nightly job prunes by RETENTION, with each one's default, bounds and unit. A stored RETENTION
 * names only the fields the sysop changed.
 */
export const RETENTION_FIELDS = {
  /** The Shack raw-packet ring (packets_recent). */
  packetsHours: { default: 24, min: 1, max: 8760, unit: "hours" },
  /** The firehose message log and MeshCom group messages. */
  messagesDays: { default: 7, min: 1, max: 3650, unit: "days" },
  /** Weather and telemetry readings. */
  sensorDays: { default: 30, min: 1, max: 3650, unit: "days" },
  /** Per-port RX/TX counters. */
  portStatsDays: { default: 7, min: 1, max: 3650, unit: "days" },
  /** Watch alerts the user has seen. */
  alertsDays: { default: 30, min: 1, max: 3650, unit: "days" },
  /** NET/ROM node MHeard rows. */
  mheardDays: { default: 7, min: 1, max: 3650, unit: "days" },
} as const;
export type RetentionField = keyof typeof RETENTION_FIELDS;

/** The most donation links a stored SUPPORT_LINKS holds, and the longest label. */
export const SUPPORT_LINKS_MAX = 12;
const LINK_LABEL_MAX = 60;
/** The most contact URIs a stored SECURITY_CONTACT holds. */
const CONTACTS_MAX = 5;
const STRING_MAX = 200;

const EMAIL_RE = /^[^\s@,<>"]+@[^\s@,<>"]+\.[^\s@,<>"]+$/;
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

type Checked = { value: string } | { error: string };
const bad = (error: string): Checked => ({ error });

const isHttpUrl = (u: string): boolean => {
  try {
    const p = new URL(u).protocol;
    return p === "https:" || p === "http:";
  } catch {
    return false;
  }
};

/** A security contact as a URI: `mailto:` or `https:`, a bare address taken as `mailto:`; null otherwise. */
function contactUri(c: string): string | null {
  const v = c.trim();
  if (/^mailto:/i.test(v)) return EMAIL_RE.test(v.slice(7)) ? `mailto:${v.slice(7)}` : null;
  if (EMAIL_RE.test(v)) return `mailto:${v}`;
  try {
    return new URL(v).protocol === "https:" ? v : null;
  } catch {
    return null;
  }
}

function checkNumber(n: number, s: { min?: number; max?: number }, integer: boolean): string | null {
  if (!Number.isFinite(n) || (integer && !Number.isInteger(n)))
    return integer ? "Enter a whole number." : "Enter a number.";
  if (s.min !== undefined && n < s.min) return `Enter ${s.min} or more.`;
  if (s.max !== undefined && n > s.max) return `Enter ${s.max} or less.`;
  return null;
}

function checkLinks(raw: string): Checked {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return bad("Enter the links as a JSON list.");
  }
  if (!Array.isArray(v)) return bad("Enter the links as a list.");
  if (v.length > SUPPORT_LINKS_MAX) return bad(`Enter at most ${SUPPORT_LINKS_MAX} links.`);
  const out: { label: string; url: string }[] = [];
  for (const [i, e] of v.entries()) {
    const { label, url } = (e ?? {}) as { label?: unknown; url?: unknown };
    const l = typeof label === "string" ? label.trim() : "";
    const u = typeof url === "string" ? url.trim() : "";
    if (!l || l.length > LINK_LABEL_MAX || CONTROL_RE.test(l))
      return bad(`Link ${i + 1}: enter a label of 1–${LINK_LABEL_MAX} characters.`);
    if (!isHttpUrl(u)) return bad(`Link ${i + 1}: enter an http or https address.`);
    out.push({ label: l, url: u });
  }
  return { value: JSON.stringify(out) };
}

function checkRetention(raw: string): Checked {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return bad("Enter the retention periods as a JSON object.");
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return bad("Enter the retention periods as an object.");
  const out: Partial<Record<RetentionField, number>> = {};
  for (const [k, n] of Object.entries(v)) {
    const f = RETENTION_FIELDS[k as RetentionField];
    if (!f) return bad(`${k} is not a retention period.`);
    const p = checkNumber(typeof n === "number" ? n : NaN, f, true);
    if (p) return bad(`${k}: ${p}`);
    out[k as RetentionField] = n as number;
  }
  return { value: JSON.stringify(out) };
}

function checkList(raw: string, s: SiteSetting): Checked {
  const items = [
    ...new Set(
      raw
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean),
    ),
  ];
  if (s.format === "contacts") {
    if (items.length > CONTACTS_MAX) return bad(`Enter at most ${CONTACTS_MAX} contacts.`);
    const uris: string[] = [];
    for (const c of items) {
      const u = contactUri(c);
      if (!u) return bad(`${c} is neither an email address nor an https address.`);
      uris.push(u);
    }
    return { value: uris.join(",") };
  }
  if (s.options) {
    const lower = items.map((x) => x.toLowerCase());
    const unknown = lower.find((x) => !s.options!.includes(x));
    if (unknown) return bad(`${unknown} is not one of: ${s.options.join(", ")}.`);
    return { value: s.options.filter((o) => lower.includes(o)).join(",") };
  }
  return { value: items.join(",") };
}

/**
 * Check a value a sysop submits for a site setting and return it in the form it is stored: trimmed, a number
 * in its bounds, list items deduplicated, JSON compact. A blank value is refused — resetting to the default
 * is its own action, so a stored value is never empty.
 */
export function checkSiteValue(key: SiteSettingKey, input: unknown): Checked {
  const k = CONFIG_KEYS[key] as ConfigKey;
  const s = k.site!;
  if (typeof input !== "string") return bad("Send the value as text.");
  const raw = input.trim();
  if (!raw) return bad("Enter a value, or reset the setting to its default.");
  if (raw.length > 4000) return bad("Enter at most 4000 characters.");
  let out: Checked;
  switch (k.type) {
    case "int":
    case "number": {
      const p = checkNumber(Number(raw), s, k.type === "int");
      out = p ? bad(p) : { value: String(Number(raw)) };
      break;
    }
    case "enum":
      out = (k.values ?? []).includes(raw) ? { value: raw } : bad(`Choose one of: ${(k.values ?? []).join(", ")}.`);
      break;
    case "list":
      out = checkList(raw, s);
      break;
    case "json":
      out =
        s.format === "links" ? checkLinks(raw) : s.format === "retention" ? checkRetention(raw) : bad("Enter JSON.");
      break;
    default: {
      const max = s.maxLength ?? STRING_MAX;
      if (raw.length > max) out = bad(`Enter at most ${max} characters.`);
      else if (CONTROL_RE.test(raw)) out = bad("Enter one line of text.");
      else if (s.format === "email" && !EMAIL_RE.test(raw)) out = bad("Enter an email address such as op@example.net.");
      else out = { value: raw };
    }
  }
  if ("error" in out) return out;
  const typeProblem = configValueProblem(key, out.value);
  return typeProblem ? bad(`${typeProblem[0]!.toUpperCase()}${typeProblem.slice(1)}.`) : out;
}
