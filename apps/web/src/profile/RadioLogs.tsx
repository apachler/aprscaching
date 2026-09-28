// SPDX-License-Identifier: AGPL-3.0-or-later
import { useCallback, useEffect, useState } from "react";
import { getRadioCommands, decideRadioCommand, type RadioCommandRow } from "../api.js";
import { useFmt } from "../format.js";
import { Group, Badge, TierBadge, EmptyState, ErrorState, useConfirm, useToast } from "../ui/index.js";

const STATUS_LABEL: Record<RadioCommandRow["status"], string> = {
  logged: "logged",
  pending: "to confirm",
  rejected: "not logged",
  help: "help sent",
  discarded: "discarded",
  expired: "expired",
};
const STATUS_KIND: Partial<Record<RadioCommandRow["status"], string>> = {
  logged: "found",
  pending: "warn",
  rejected: "dnf",
};

/**
 * Logs sent over the air — FOUND / DNF / NOTE messages the player sent from a radio to the instance's
 * service call. Messages that arrived only over the internet wait here until the player confirms them.
 */
export function RadioLogs() {
  const fmt = useFmt();
  const toast = useToast();
  const confirmDialog = useConfirm();
  const [data, setData] = useState<{ serviceCall: string; commands: RadioCommandRow[] } | null>(null);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState<number | null>(null);

  const load = useCallback(() => {
    setError(false);
    getRadioCommands()
      .then(setData)
      .catch(() => setError(true));
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  async function decide(c: RadioCommandRow, decision: "confirm" | "discard") {
    if (
      decision === "discard" &&
      !(await confirmDialog({
        title: `Discard ${c.command.toUpperCase()} ${c.cacheCode ?? ""}?`,
        message: "The message is not logged. You can still log the cache in the app.",
        confirmLabel: "Discard",
      }))
    )
      return;
    setBusy(c.id);
    try {
      await decideRadioCommand(c.id, decision);
      toast(decision === "confirm" ? `${c.cacheCode} logged` : "Discarded");
    } catch (e) {
      toast((e as Error).message);
    } finally {
      setBusy(null);
      load();
    }
  }

  const pending = data?.commands.filter((c) => c.status === "pending").length ?? 0;
  const service = data?.serviceCall ?? "APRSCG";
  return (
    <Group
      // remount once loaded so the group opens by itself when something waits for confirmation
      key={data ? "loaded" : "loading"}
      title="Logs sent over the air"
      status={pending ? `${pending} to confirm` : undefined}
      defaultOpen={pending > 0}
    >
      <p className="muted">
        Send <span className="mono">FOUND AC-1234</span> (or <span className="mono">DNF</span>,{" "}
        <span className="mono">NOTE</span>, <span className="mono">HELP</span>) from your radio to{" "}
        <span className="mono">{service}</span>. A message heard by one of this instance&apos;s own stations is logged
        at once; one that only came over the internet waits here for you to confirm.
      </p>
      {error ? (
        <ErrorState onRetry={load}>Couldn&apos;t load your radio logs.</ErrorState>
      ) : !data ? (
        <p className="muted" aria-busy="true">
          Loading…
        </p>
      ) : data.commands.length === 0 ? (
        <EmptyState>No logs sent over the air yet.</EmptyState>
      ) : (
        <ul className="logs">
          {data.commands.map((c) => (
            <li key={c.id}>
              <Badge>{c.command.toUpperCase()}</Badge> {c.cacheCode && <span className="mono">{c.cacheCode}</span>}{" "}
              <Badge kind={STATUS_KIND[c.status]}>{STATUS_LABEL[c.status]}</Badge>
              {c.command === "found" && c.tier && (
                <>
                  {" "}
                  <TierBadge tier={c.tier} verified={c.verified} />
                </>
              )}
              <div className="muted">
                <span className="mono">{c.fromCall}</span> · {fmt.ago(c.sentAt)}
              </div>
              {c.body && <div className="muted">{c.body}</div>}
              {c.reason && <div className="muted">{c.reason}</div>}
              {c.status === "pending" && (
                <div className="row gap-2">
                  <button className="primary" disabled={busy === c.id} onClick={() => void decide(c, "confirm")}>
                    Confirm
                  </button>
                  <button disabled={busy === c.id} onClick={() => void decide(c, "discard")}>
                    Discard
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </Group>
  );
}
