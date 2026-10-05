// SPDX-License-Identifier: AGPL-3.0-or-later
import { useState } from "react";
import { cacheShareUrl, errorText } from "../api.js";
import { useFmt } from "../format.js";
import {
  Button,
  Badge,
  EmptyState,
  ErrorState,
  LoadMore,
  Segmented,
  usePrompt,
  useToast,
  useLoad,
} from "../ui/index.js";
import {
  listReports,
  decideReport,
  removeContent,
  restoreCache,
  searchAccounts,
  suspendedAccounts,
  getModAccount,
  suspendAccount,
  unsuspendAccount,
  getAuditLog,
  type ModReport,
  type ModAccount,
  type ModAction,
  type ModContent,
  type ErasedCallSuspension,
} from "../moderation/api.js";
import {
  REPORT_CATEGORIES,
  SUSPENSION_SPANS,
  actionName,
  kindName,
  suspensionUntil,
  type ContentKind,
  type ReportCategory,
} from "../moderation/logic.js";

/**
 * The sysop's moderation groups in Instance admin: the Reports queue, Accounts (find, open, suspend) and the
 * Audit log. Every action here is gated server-side (requireSysop); these controls only call it.
 */

const categoryLabel = (c: string) => REPORT_CATEGORIES.find((x) => x.value === c)?.label ?? c;

/** A link that opens the cache an item belongs to, in the app. */
function CacheLink(props: { code: string | null | undefined }) {
  if (!props.code) return null;
  return (
    <a href={cacheShareUrl(props.code)} target="_blank" rel="noreferrer noopener" className="mono">
      {props.code}
    </a>
  );
}

/** Ask for a removal reason and remove the item; resolves true once it is gone. */
function useRemove() {
  const prompt = usePrompt();
  const toast = useToast();
  return async (kind: ContentKind, id: string | number, label: string, reportId?: number): Promise<boolean> => {
    const a = await prompt({
      title: `Remove this ${kindName(kind)}?`,
      message: (
        <>
          <span className="mono">{label}</span>{" "}
          {kind === "cache"
            ? "is hidden from everyone but its owner, and peers drop their copy."
            : kind === "profile"
              ? "loses its name, bio, avatar and links; the account stays."
              : "is deleted for good."}
        </>
      ),
      label: "Reason (the owner is told)",
      minLength: 3,
      maxLength: 500,
      confirmLabel: "Remove",
      danger: true,
    });
    if (!a) return false;
    try {
      await removeContent(kind, id, a.text, reportId);
      toast(`${label} removed`);
      return true;
    } catch (e) {
      toast(errorText(e));
      return false;
    }
  };
}

// ---------------------------------------------------------------- Reports

export function ReportsAdmin(props: { onChanged?: () => void }) {
  const fmt = useFmt();
  const toast = useToast();
  const prompt = usePrompt();
  const remove = useRemove();
  const [status, setStatus] = useState<"open" | "resolved">("open");
  const reports = useLoad(() => listReports(status), [status]);
  const [busy, setBusy] = useState<number | null>(null);

  const decide = async (r: ModReport, to: "open" | "resolved") => {
    let note: string | undefined;
    if (to === "resolved") {
      const a = await prompt({
        title: "Resolve this report?",
        message: "It leaves the queue with no action on the item.",
        label: "Note (optional)",
        maxLength: 500,
        confirmLabel: "Resolve",
      });
      if (!a) return;
      note = a.text || undefined;
    }
    setBusy(r.id);
    try {
      await decideReport(r.id, to, note);
      toast(to === "resolved" ? "Report resolved" : "Report reopened");
      reports.reload();
      props.onChanged?.();
    } catch (e) {
      toast(errorText(e));
    } finally {
      setBusy(null);
    }
  };
  const takeDown = async (r: ModReport) => {
    setBusy(r.id);
    if (await remove(r.kind, r.targetId, r.label ?? `${kindName(r.kind)} ${r.targetId}`, r.id)) {
      reports.reload();
      props.onChanged?.();
    }
    setBusy(null);
  };

  const counts = reports.data?.counts;
  return (
    <>
      <Segmented
        label="Which reports"
        value={status}
        onChange={setStatus}
        options={[
          { value: "open", label: `Open${counts ? ` (${counts.open})` : ""}` },
          { value: "resolved", label: `Resolved${counts ? ` (${counts.resolved})` : ""}` },
        ]}
      />
      {reports.error && !reports.data ? (
        <ErrorState onRetry={reports.reload}>Couldn&apos;t load the reports.</ErrorState>
      ) : !reports.data ? (
        <p className="muted" role="status">
          Loading…
        </p>
      ) : reports.data.reports.length === 0 ? (
        <EmptyState>
          {status === "open"
            ? "No open reports. Players report from the More (⋯) menu on a cache, a log, a photo, a message or a profile."
            : "No resolved reports yet."}
        </EmptyState>
      ) : (
        <ul className="logs">
          {reports.data.reports.map((r) => (
            <li key={r.id}>
              <div className="row between">
                <span>
                  <Badge kind="warn">{categoryLabel(r.category)}</Badge> <Badge>{kindName(r.kind)}</Badge>{" "}
                  {r.gone && <Badge>gone</Badge>}
                </span>
                <span className="muted fine">{fmt.ago(r.createdAt)}</span>
              </div>
              <div>
                {r.label ?? `${kindName(r.kind)} ${r.targetId}`}
                {r.code && (
                  <>
                    {" · "}
                    <CacheLink code={r.code} />
                  </>
                )}
                {r.ownerCall && (
                  <span className="muted">
                    {" "}
                    · by <span className="mono">{r.ownerCall}</span>
                  </span>
                )}
              </div>
              {r.preview && <div className="comment muted">{r.preview}</div>}
              {r.text && <div className="comment">“{r.text}”</div>}
              <div className="muted fine">
                reported by {r.reporter ? <span className="mono">{r.reporter}</span> : "a signed-out visitor"}
                {r.status === "resolved" && (
                  <>
                    {" "}
                    · resolved by <span className="mono">{r.resolvedBy}</span>
                    {r.resolvedAt ? ` ${fmt.ago(r.resolvedAt)}` : ""}
                    {r.resolution ? `: ${r.resolution}` : ""}
                  </>
                )}
              </div>
              <div className="row">
                {r.status === "open" ? (
                  <>
                    {!r.gone && (
                      <Button
                        variant="inline-danger"
                        disabled={busy !== null}
                        aria-busy={busy === r.id}
                        onClick={() => void takeDown(r)}
                      >
                        Remove…
                      </Button>
                    )}
                    <Button disabled={busy !== null} onClick={() => void decide(r, "resolved")}>
                      Resolve
                    </Button>
                  </>
                ) : (
                  <Button disabled={busy !== null} onClick={() => void decide(r, "open")}>
                    Reopen
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

// ---------------------------------------------------------------- Accounts

export function AccountsAdmin() {
  const fmt = useFmt();
  const [mode, setMode] = useState<"search" | "suspended">("search");
  const [q, setQ] = useState("");
  const [query, setQuery] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const list = useLoad(
    () =>
      mode === "suspended"
        ? suspendedAccounts()
        : query
          ? searchAccounts(query)
          : Promise.resolve({ accounts: [] as ModAccount[], erasedCalls: [] }),
    [mode, query],
  );
  const search = () => {
    const t = q.trim();
    if (t.length >= 2) setQuery(t);
  };

  if (open)
    return (
      <AccountDetail
        callsign={open}
        onBack={() => {
          setOpen(null);
          list.reload();
        }}
      />
    );
  return (
    <>
      <Segmented
        label="Which accounts"
        value={mode}
        onChange={setMode}
        options={[
          { value: "search", label: "Look up" },
          { value: "suspended", label: "Suspended" },
        ]}
      />
      {mode === "search" && (
        <form
          className="row mod-search"
          onSubmit={(e) => {
            e.preventDefault();
            search();
          }}
        >
          <label className="srch">
            <span className="sr-only">Callsign or email</span>
            <input
              value={q}
              placeholder="Callsign or email…"
              autoCapitalize="characters"
              spellCheck={false}
              onChange={(e) => setQ(e.target.value)}
            />
          </label>
          <Button type="submit" disabled={q.trim().length < 2}>
            Search
          </Button>
        </form>
      )}
      {list.error && !list.data ? (
        <ErrorState onRetry={list.reload}>Couldn&apos;t load the accounts.</ErrorState>
      ) : !list.data || list.loading ? (
        mode === "search" && !query ? (
          <p className="muted fine">Type at least two characters of a callsign or an email address.</p>
        ) : (
          <p className="muted" role="status">
            Loading…
          </p>
        )
      ) : list.data.accounts.length === 0 && !(list.data.erasedCalls?.length ?? 0) ? (
        <EmptyState>
          {mode === "suspended"
            ? "No account is suspended."
            : query
              ? `No account matches “${query}”.`
              : "Type at least two characters of a callsign or an email address."}
        </EmptyState>
      ) : (
        <ul className="logs">
          {list.data.accounts.map((a) => (
            <li key={a.callsign}>
              <div className="row between">
                <span>
                  <span className="mono">{a.callsign}</span>
                  {a.calls.length > 1 && <span className="muted"> · {a.calls.join(", ")}</span>}{" "}
                  {a.suspended && <Badge kind="warn">suspended</Badge>} {a.operator && <Badge>operator</Badge>}
                </span>
                <Button onClick={() => setOpen(a.callsign)}>Open</Button>
              </div>
              <div className="muted fine">
                {a.email ?? "no email"} · joined {fmt.date(a.createdAt)}
              </div>
            </li>
          ))}
          {(list.data.erasedCalls ?? []).map((s) => (
            <ErasedCallRow key={s.callsign} s={s} onLifted={list.reload} />
          ))}
        </ul>
      )}
    </>
  );
}

/** A call whose account was erased while suspended: no account to open, only the record and Lift suspension. */
function ErasedCallRow(props: { s: ErasedCallSuspension; onLifted: () => void }) {
  const fmt = useFmt();
  const toast = useToast();
  const prompt = usePrompt();
  const [busy, setBusy] = useState(false);
  const { s } = props;
  const lift = async () => {
    const ans = await prompt({
      title: `Lift the suspension of ${s.callsign}?`,
      message: "Its account was erased. Lifting frees the callsign for a new registration or claim.",
      label: "Reason",
      minLength: 3,
      maxLength: 500,
      confirmLabel: "Lift suspension",
    });
    if (!ans) return;
    setBusy(true);
    try {
      await unsuspendAccount(s.callsign, ans.text);
      toast(`${s.callsign} is free again`);
      props.onLifted();
    } catch (e) {
      toast(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <li>
      <div className="row between">
        <span>
          <span className="mono">{s.callsign}</span> <Badge kind="warn">suspended</Badge> <Badge>account erased</Badge>
        </span>
        <Button disabled={busy} aria-busy={busy} onClick={() => void lift()}>
          Lift suspension
        </Button>
      </div>
      <div className="muted fine">
        {categoryLabel(s.category)} · since {fmt.date(s.at)} · {s.until ? `until ${fmt.date(s.until)}` : "until lifted"}
      </div>
    </li>
  );
}

function AccountDetail(props: { callsign: string; onBack: () => void }) {
  const fmt = useFmt();
  const toast = useToast();
  const prompt = usePrompt();
  const remove = useRemove();
  const acct = useLoad(() => getModAccount(props.callsign), [props.callsign]);
  const [busy, setBusy] = useState(false);
  const d = acct.data;

  const suspend = async (a: ModAccount) => {
    const ans = await prompt({
      title: `Suspend ${a.callsign}?`,
      message:
        "Every session ends now. Sign-in, writes and transmissions are refused until the end you pick. Their public content stays.",
      select: { label: "How long", options: SUSPENSION_SPANS },
      select2: { label: "Category (kept on the callsign if the account is erased)", options: REPORT_CATEGORIES },
      label: "Reason (the person is told)",
      minLength: 3,
      maxLength: 500,
      confirmLabel: "Suspend",
      danger: true,
    });
    if (!ans) return;
    await run(
      () =>
        suspendAccount(
          a.callsign,
          ans.text,
          (ans.choice2 ?? "other") as ReportCategory,
          suspensionUntil(ans.choice, Date.now()),
        ),
      "suspended",
    );
  };
  const lift = async (a: ModAccount) => {
    const ans = await prompt({
      title: `Lift the suspension of ${a.callsign}?`,
      label: "Reason (the person is told)",
      minLength: 3,
      maxLength: 500,
      confirmLabel: "Lift suspension",
    });
    if (!ans) return;
    await run(() => unsuspendAccount(a.callsign, ans.text), "is active again");
  };
  const run = async (fn: () => Promise<unknown>, done: string) => {
    setBusy(true);
    try {
      await fn();
      toast(`${props.callsign} ${done}`);
      acct.reload();
    } catch (e) {
      toast(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const restore = async (c: ModContent) => {
    const ans = await prompt({
      title: `Restore ${c.code ?? c.label}?`,
      message: "It comes back disabled; its owner enables it again. Peers mirror it again.",
      label: "Reason (the owner is told)",
      minLength: 3,
      maxLength: 500,
      confirmLabel: "Restore",
    });
    if (!ans) return;
    await run(() => restoreCache(Number(c.id), ans.text), "— cache restored");
  };

  return (
    <>
      <div className="row">
        <Button onClick={props.onBack}>← accounts</Button>
      </div>
      {acct.error && !d ? (
        <ErrorState onRetry={acct.reload}>Couldn&apos;t load {props.callsign}.</ErrorState>
      ) : !d ? (
        <p className="muted" role="status">
          Loading…
        </p>
      ) : (
        <>
          <h4 className="set-subh">
            <span className="mono">{d.account.callsign}</span>{" "}
            {d.account.suspended ? <Badge kind="warn">suspended</Badge> : <Badge kind="found">active</Badge>}
          </h4>
          <p className="muted fine">
            {d.account.calls.join(", ")} · {d.account.email ?? "no email"} · joined {fmt.date(d.account.createdAt)}
            {d.openReports > 0 && ` · ${d.openReports} open report${d.openReports === 1 ? "" : "s"}`}
          </p>
          {d.account.suspended && (
            <p className="inline-note" role="status">
              Suspended {fmt.ago(d.account.suspended.at)}
              {d.account.suspended.until ? ` until ${fmt.date(d.account.suspended.until)}` : " until lifted"}:{" "}
              {categoryLabel(d.account.suspended.category)} — {d.account.suspended.reason}
            </p>
          )}
          <div className="row">
            {d.account.operator ? (
              <p className="muted fine">An operator&apos;s account cannot be suspended here.</p>
            ) : d.account.suspended ? (
              <Button disabled={busy} aria-busy={busy} onClick={() => void lift(d.account)}>
                Lift suspension
              </Button>
            ) : (
              <Button variant="inline-danger" disabled={busy} aria-busy={busy} onClick={() => void suspend(d.account)}>
                Suspend…
              </Button>
            )}
          </div>

          <h4 className="set-subh">Content</h4>
          {d.content.length === 0 ? (
            <EmptyState>{d.account.callsign} has no caches, logs, media or messages here.</EmptyState>
          ) : (
            <ul className="logs">
              {d.content.map((c) => (
                <li key={`${c.kind}-${c.id}`}>
                  <div className="row between">
                    <span>
                      <Badge>{kindName(c.kind)}</Badge> {c.label}
                      {c.removed && (
                        <>
                          {" "}
                          <Badge kind="warn">removed</Badge>
                        </>
                      )}
                      {c.code && c.kind !== "cache" && (
                        <>
                          {" · "}
                          <CacheLink code={c.code} />
                        </>
                      )}
                    </span>
                    {c.at != null && <span className="muted fine">{fmt.ago(c.at)}</span>}
                  </div>
                  {c.preview && <div className="comment muted">{c.preview}</div>}
                  <div className="row">
                    {c.kind === "cache" && c.code && <CacheLink code={c.code} />}
                    {c.removed ? (
                      <Button disabled={busy} onClick={() => void restore(c)}>
                        Restore
                      </Button>
                    ) : (
                      <Button
                        variant="inline-danger"
                        disabled={busy}
                        onClick={() => void remove(c.kind, c.id, c.label).then((ok) => ok && acct.reload())}
                      >
                        Remove…
                      </Button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}

          <h4 className="set-subh">Actions taken</h4>
          {d.actions.length === 0 ? (
            <EmptyState>No moderation action on this account yet.</EmptyState>
          ) : (
            <AuditRows rows={d.actions} />
          )}
        </>
      )}
    </>
  );
}

// ---------------------------------------------------------------- Audit log

function AuditRows(props: { rows: ModAction[] }) {
  const fmt = useFmt();
  return (
    <ul className="logs">
      {props.rows.map((e) => (
        <li key={e.id}>
          <span className="mono">{e.actor}</span> {actionName(e.action)} {kindName(e.kind)}{" "}
          <span className="mono">{e.label ?? e.targetId}</span>
          <span className="muted fine"> · {fmt.dateTime(e.at)}</span>
          {e.reason && <div className="comment">{e.reason}</div>}
        </li>
      ))}
    </ul>
  );
}

export function AuditAdmin() {
  const first = useLoad(() => getAuditLog(), []);
  const [more, setMore] = useState<ModAction[]>([]);
  const [next, setNext] = useState<number | null | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const cursor = next === undefined ? (first.data?.nextBefore ?? null) : next;
  const loadMore = async () => {
    if (!cursor) return;
    setLoading(true);
    setErr(null);
    try {
      const r = await getAuditLog(cursor);
      setMore((m) => [...m, ...r.entries]);
      setNext(r.nextBefore);
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setLoading(false);
    }
  };
  if (first.error && !first.data)
    return <ErrorState onRetry={first.reload}>Couldn&apos;t load the audit log.</ErrorState>;
  if (!first.data)
    return (
      <p className="muted" role="status">
        Loading…
      </p>
    );
  const rows = [...first.data.entries, ...more];
  return (
    <>
      {rows.length === 0 ? (
        <EmptyState>
          No moderation action yet. Removals, suspensions, settled reports and changes to the instance settings show
          here.
        </EmptyState>
      ) : (
        <AuditRows rows={rows} />
      )}
      {err && (
        <p className="error fine" role="alert">
          {err}
        </p>
      )}
      <LoadMore hasMore={!!cursor} loading={loading} onClick={() => void loadMore()} />
    </>
  );
}
