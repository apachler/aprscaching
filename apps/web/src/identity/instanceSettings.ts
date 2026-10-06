// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The pure parts of Instance admin → Instance settings: which control a setting takes, the form's draft of a
 * value and the value it submits, the search filter, and the words for a setting's source. The gateway checks
 * every value again (sitesettings.ts); the form checks first with the same rules, so a mistake shows inline
 * before anything is sent.
 */
import { checkSiteValue, isSiteSettingKey } from "@aprscaching/shared";
import type { SiteSettingView } from "../api.js";

type ControlKind = "switch" | "choice" | "number" | "text" | "options" | "contacts" | "links" | "retention";

export function controlKind(s: SiteSettingView): ControlKind {
  if (s.control === "switch") return "switch";
  if (s.type === "enum") return "choice";
  if (s.type === "int" || s.type === "number") return "number";
  if (s.type === "list") return s.format === "contacts" ? "contacts" : s.options ? "options" : "text";
  if (s.type === "json") return s.format === "links" ? "links" : "retention";
  return "text";
}

/** A switch's state: the flag spellings 1, true and yes are on. */
export const flagOn = (v: string | null): boolean => v === "1" || v === "true" || v === "yes";

export interface Link {
  label: string;
  url: string;
}

/** What the form edits: text for a field, the ticked ids, the rows of a list, or one field per retention period. */
export type Draft = string | string[] | Link[] | Record<string, string>;

const splitList = (v: string | null): string[] =>
  (v ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);

function parseObject(v: string | null): Record<string, unknown> {
  try {
    const o = JSON.parse(v ?? "") as unknown;
    return o && typeof o === "object" && !Array.isArray(o) ? (o as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function parseLinks(v: string | null): Link[] {
  try {
    const a = JSON.parse(v ?? "") as unknown;
    if (!Array.isArray(a)) return [];
    return a.map((e) => {
      const { label, url } = (e ?? {}) as { label?: unknown; url?: unknown };
      return { label: typeof label === "string" ? label : "", url: typeof url === "string" ? url : "" };
    });
  } catch {
    return [];
  }
}

/** The draft the form opens with: the setting's current value. */
export function draftOf(s: SiteSettingView): Draft {
  switch (controlKind(s)) {
    case "options":
      return splitList(s.value).map((x) => x.toLowerCase());
    case "contacts":
      return splitList(s.value).map((x) => x.replace(/^mailto:/i, ""));
    case "links":
      return parseLinks(s.value);
    case "retention": {
      const o = parseObject(s.value);
      return Object.fromEntries(
        (s.fields ?? []).map((f) => [f.id, typeof o[f.id] === "number" ? String(o[f.id]) : ""]),
      );
    }
    default:
      return s.value ?? "";
  }
}

/** The value a draft submits, as the gateway stores it; an empty draft submits "". */
export function encodeDraft(s: SiteSettingView, d: Draft): string {
  switch (controlKind(s)) {
    case "options":
    case "contacts":
      return (d as string[])
        .map((x) => x.trim())
        .filter(Boolean)
        .join(",");
    case "links": {
      const rows = (d as Link[]).filter((l) => l.label.trim() || l.url.trim());
      return JSON.stringify(rows.map((l) => ({ label: l.label.trim(), url: l.url.trim() })));
    }
    case "retention": {
      const out: Record<string, number> = {};
      for (const [k, v] of Object.entries(d as Record<string, string>)) if (v.trim() !== "") out[k] = Number(v);
      return Object.keys(out).length ? JSON.stringify(out) : "";
    }
    default:
      return (d as string).trim();
  }
}

/**
 * The value to send, or why it cannot be: the same check the gateway runs. An empty draft has nothing to store,
 * so it points at Reset to default instead.
 */
export function submission(s: SiteSettingView, d: Draft): { value: string } | { error: string } {
  const v = encodeDraft(s, d);
  if (!v) return { error: "Nothing to save. To go back to the default, use Reset to default." };
  if (!isSiteSettingKey(s.key)) return { error: "This is not an instance setting." };
  return checkSiteValue(s.key, v);
}

/** Whether the draft differs from what applies now. */
export const isDirty = (s: SiteSettingView, d: Draft): boolean => encodeDraft(s, d) !== encodeDraft(s, draftOf(s));

/** The search filter: a setting matches on its label, hint, key or group title. */
export function matches(s: SiteSettingView, groupTitle: string, q: string): boolean {
  const t = q.trim().toLowerCase();
  if (!t) return true;
  return [s.label, s.hint, s.key, s.key.replace(/_/g, " "), groupTitle].some((w) => w.toLowerCase().includes(t));
}

/** A group's header status: how many of its settings this page changed and how many the environment sets. */
export function groupStatus(settings: SiteSettingView[]): string {
  const site = settings.filter((s) => s.source === "site").length;
  const env = settings.filter((s) => s.source === "env").length;
  const parts = [site ? `${site} changed here` : "", env ? `${env} set by the environment` : ""].filter(Boolean);
  return parts.length ? parts.join(" · ") : "defaults";
}

/** The source badge: its words, its colour and the one line it explains on hover. */
export function sourceBadge(s: SiteSettingView): { text: string; kind: string; title: string } {
  if (s.source === "env")
    return {
      text: "Set by the environment",
      kind: "src-env",
      title: `The environment sets ${s.key}, which wins over this page. Change it there and restart the gateway.`,
    };
  if (s.source === "site")
    return { text: "Changed here", kind: "src-site", title: "Saved on this page; Reset to default clears it." };
  return { text: "Default", kind: "", title: "The built-in default; nothing has changed it." };
}

/** The default as the form shows it beside Reset. */
export function defaultText(s: SiteSettingView): string {
  if (controlKind(s) === "retention") return "each period's own";
  if (s.default === null) return "none";
  if (controlKind(s) === "switch") return flagOn(s.default) ? "on" : "off";
  return s.unit ? `${s.default} ${s.unit}` : s.default;
}
