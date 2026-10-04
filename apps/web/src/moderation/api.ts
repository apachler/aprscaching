// SPDX-License-Identifier: AGPL-3.0-or-later
/** The moderation endpoints: filing a report (any player), and the sysop's reports, takedowns and suspensions. */
import { call } from "../api.js";
import type { ContentKind, ReportCategory } from "./logic.js";

export function fileReport(kind: ContentKind, id: string | number, category: ReportCategory, text: string) {
  return call<{ ok: true; id: number; duplicate?: boolean }>(`/api/reports`, {
    method: "POST",
    body: JSON.stringify({ kind, id: String(id), category, text }),
  });
}

/** One report in the sysop's queue, with the current state of what it names. */
export interface ModReport {
  id: number;
  kind: ContentKind;
  targetId: string;
  label: string | null;
  preview: string | null;
  ownerCall: string | null;
  cacheId: number | null;
  code: string | null;
  /** The item no longer exists, or the cache is already removed. */
  gone: boolean;
  category: ReportCategory;
  text: string | null;
  reporter: string | null;
  status: "open" | "resolved";
  resolution: string | null;
  resolvedBy: string | null;
  resolvedAt: number | null;
  createdAt: number;
}
export function listReports(status: "open" | "resolved") {
  return call<{ reports: ModReport[]; counts: { open: number; resolved: number } }>(
    `/api/admin/moderation/reports?status=${status}`,
  );
}
export function decideReport(id: number, status: "open" | "resolved", note?: string) {
  return call<{ ok: true }>(`/api/admin/moderation/reports/${id}`, {
    method: "POST",
    body: JSON.stringify({ status, note }),
  });
}

export function removeContent(kind: ContentKind, id: string | number, reason: string) {
  return call<{ ok: true; tombstones: number }>(`/api/admin/moderation/remove`, {
    method: "POST",
    body: JSON.stringify({ kind, id: String(id), reason }),
  });
}
export function restoreCache(id: number, reason: string) {
  return call<{ ok: true }>(`/api/admin/moderation/restore`, {
    method: "POST",
    body: JSON.stringify({ kind: "cache", id: String(id), reason }),
  });
}

export interface Suspension {
  reason: string;
  until: number | null;
  at: number;
}
export interface ModAccount {
  callsign: string;
  calls: string[];
  email: string | null;
  createdAt: number;
  suspended: Suspension | null;
  /** Holds a call named in ADMIN_CALLSIGNS: never suspended from here. */
  operator: boolean;
}
export interface ModContent {
  kind: ContentKind;
  id: string;
  label: string;
  preview: string | null;
  at: number | null;
  cacheId?: number;
  code?: string | null;
  status?: string;
  removed?: boolean;
}
export interface ModAction {
  id: number;
  at: number;
  actor: string;
  action: string;
  kind: string;
  targetId: string;
  label: string | null;
  reason: string | null;
}

export function searchAccounts(q: string) {
  return call<{ accounts: ModAccount[] }>(`/api/admin/moderation/accounts?q=${encodeURIComponent(q)}`);
}
export function suspendedAccounts() {
  return call<{ accounts: ModAccount[] }>(`/api/admin/moderation/accounts?suspended=1`);
}
export function getModAccount(call_: string) {
  return call<{ account: ModAccount; openReports: number; content: ModContent[]; actions: ModAction[] }>(
    `/api/admin/moderation/accounts/${encodeURIComponent(call_)}`,
  );
}
export function suspendAccount(call_: string, reason: string, until: number | null) {
  return call<{ ok: true }>(`/api/admin/moderation/accounts/${encodeURIComponent(call_)}/suspend`, {
    method: "POST",
    body: JSON.stringify({ reason, until }),
  });
}
export function unsuspendAccount(call_: string, reason: string) {
  return call<{ ok: true }>(`/api/admin/moderation/accounts/${encodeURIComponent(call_)}/unsuspend`, {
    method: "POST",
    body: JSON.stringify({ reason }),
  });
}
export function getAuditLog(before?: number | null) {
  return call<{ entries: ModAction[]; nextBefore: number | null }>(
    `/api/admin/moderation/log${before ? `?before=${before}` : ""}`,
  );
}
