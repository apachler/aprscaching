// SPDX-License-Identifier: AGPL-3.0-or-later
/** Moderation's pure parts: the words for kinds, categories and actions, and the menu a viewer gets. */

export type ContentKind = "cache" | "log" | "media" | "message" | "bbs" | "mailbox" | "meshcom" | "profile";
export type ReportCategory = "spam" | "offensive" | "unsafe" | "copyright" | "other";

export const REPORT_CATEGORIES: { value: ReportCategory; label: string }[] = [
  { value: "spam", label: "Spam" },
  { value: "offensive", label: "Offensive" },
  { value: "unsafe", label: "Wrong location or unsafe" },
  { value: "copyright", label: "Copyright" },
  { value: "other", label: "Other" },
];

const KIND_NAMES: Record<ContentKind, string> = {
  cache: "cache",
  log: "log",
  media: "photo or file",
  message: "message",
  bbs: "BBS message",
  mailbox: "Mailbox message",
  meshcom: "MeshCom message",
  profile: "profile",
};
/** The kind of an item in words: "this photo or file". */
export const kindName = (k: string): string => KIND_NAMES[k as ContentKind] ?? k;

const ACTION_NAMES: Record<string, string> = {
  remove: "removed",
  restore: "restored",
  suspend: "suspended",
  unsuspend: "lifted the suspension of",
  resolve: "resolved",
  reopen: "reopened",
};
/** An audit row as a verb phrase: "OE8APR removed". */
export const actionName = (a: string): string => ACTION_NAMES[a] ?? a;

/** What the More menu on an item offers: a player reports, the sysop also removes, or restores a removed cache. */
export function menuChoices(o: { sysop: boolean; removed?: boolean; own?: boolean }): {
  label: string;
  value: "report" | "remove" | "restore";
  danger?: boolean;
}[] {
  const out: { label: string; value: "report" | "remove" | "restore"; danger?: boolean }[] = [];
  if (!o.own && !o.removed) out.push({ label: "Report…", value: "report" });
  if (o.sysop && !o.removed) out.push({ label: "Remove…", value: "remove", danger: true });
  if (o.sysop && o.removed) out.push({ label: "Restore…", value: "restore" });
  return out;
}

/** How long a suspension holds: until the sysop lifts it, or a number of days. */
export const SUSPENSION_SPANS: { value: string; label: string }[] = [
  { value: "open", label: "Until I lift it" },
  { value: "1", label: "1 day" },
  { value: "7", label: "7 days" },
  { value: "30", label: "30 days" },
  { value: "90", label: "90 days" },
];

/** The end of a suspension for a span picked from {@link SUSPENSION_SPANS}: unix seconds, or null for open. */
export function suspensionUntil(span: string | null, nowMs: number): number | null {
  const days = Number(span);
  if (!span || span === "open" || !Number.isInteger(days) || days <= 0) return null;
  return Math.floor(nowMs / 1000) + days * 86_400;
}
