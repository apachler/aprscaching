// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Logs to sync — the logs made without a connection. Two groups: the ones waiting to be sent, and the
 * ones the instance refused, each with its reason and an explicit choice (retry, edit the comment and
 * retry, or discard). Nothing leaves the device without the user seeing it (log/logQueue.ts).
 */
import { useEffect, useState } from "react";
import {
  attentionLogs,
  discardAttentionLog,
  getInstance,
  knownServiceCall,
  queuedLogs,
  removeQueuedLog,
  retryAttentionLog,
  type QueueBody,
} from "../api.js";
import { radioLogText } from "./radioText.js";
import { runSync } from "../offline/sync.js";
import { useFmt } from "../format.js";
import {
  Badge,
  Button,
  CommandBlock,
  Disclosure,
  EmptyState,
  Group,
  Panel,
  useConfirm,
  useToast,
} from "../ui/index.js";
import type { AttentionLog, QueuedLog } from "./logQueue.js";

/** When the log was made: its signed time, else when it was queued. */
const madeAt = (l: QueuedLog<QueueBody>) => l.body.author?.signedAt ?? Math.floor(l.queuedAt / 1000);
const what = (l: QueuedLog<QueueBody>) =>
  `${l.kind === "unlock" ? `stage ${l.stageNo} of ` : ""}${l.label ?? `cache #${l.cacheId}`}`;

export function OutboxPanel(props: { onClose: () => void }) {
  const fmt = useFmt();
  const toast = useToast();
  const [queue, setQueue] = useState<QueuedLog<QueueBody>[]>([]);
  const [attention, setAttention] = useState<AttentionLog<QueueBody>[]>([]);
  const [busy, setBusy] = useState(false);
  const [instance, setInstance] = useState("");
  const [serviceCall, setServiceCall] = useState<string | null>(null);
  useEffect(() => {
    void getInstance().then(setInstance);
    void knownServiceCall().then(setServiceCall);
  }, []);
  const reread = async () => {
    setQueue(await queuedLogs());
    setAttention(await attentionLogs());
  };
  useEffect(() => {
    void reread();
    const on = () => void reread();
    window.addEventListener("acs-queued", on);
    return () => window.removeEventListener("acs-queued", on);
  }, []);

  async function syncNow() {
    setBusy(true);
    try {
      // Sync now also refreshes every offline pack, whatever the connection
      const r = await runSync({ manual: true });
      await reread();
      const said = [
        r.sent && `${r.sent} sent`,
        r.refused && `${r.refused} need attention`,
        r.refreshed && `${r.refreshed} ${r.refreshed === 1 ? "pack" : "packs"} refreshed`,
        r.refreshFailed && `${r.refreshFailed} ${r.refreshFailed === 1 ? "pack" : "packs"} could not refresh`,
      ].filter(Boolean);
      toast(
        said.length
          ? said.join(" · ")
          : navigator.onLine
            ? "Nothing could be sent yet; it retries on its own"
            : "Still offline",
      );
    } finally {
      setBusy(false);
    }
  }

  const empty = queue.length === 0 && attention.length === 0;
  return (
    <Panel title="Logs to sync" onClose={props.onClose}>
      {empty ? (
        <EmptyState>Every log is synced. A log made without a connection waits here until it can be sent.</EmptyState>
      ) : (
        <>
          <Group title="Needs attention" status={attention.length ? `${attention.length}` : "none"}>
            {attention.length === 0 ? (
              <p className="muted">Nothing was refused.</p>
            ) : (
              <ul className="outbox">
                {attention.map((l, i) => (
                  <AttentionItem
                    key={`${l.cacheId}-${l.refusedAt}-${i}`}
                    log={l}
                    index={i}
                    when={fmt.dateTime(madeAt(l))}
                  />
                ))}
              </ul>
            )}
          </Group>
          <Group title="Waiting to send" status={queue.length ? `${queue.length}` : "none"}>
            {queue.length === 0 ? (
              <p className="muted">Nothing is waiting.</p>
            ) : (
              <ul className="outbox">
                {queue.map((l, i) => (
                  <li key={`${l.cacheId}-${l.queuedAt}-${i}`} className="outbox-item">
                    <div className="row">
                      <Badge kind={l.body.logType}>{l.body.logType}</Badge>
                      <span className="mono">{what(l)}</span>
                    </div>
                    <div className="muted fine">
                      made {fmt.dateTime(madeAt(l))}
                      {l.kind !== "unlock" && !l.body.author && " · unsigned: it counts from when it arrives"}
                      {l.nextAt != null && ` · next try ${fmt.time(Math.floor(l.nextAt / 1000))}`}
                      {instance &&
                        l.instance &&
                        l.instance !== instance &&
                        ` · signed for ${l.instance}: it goes only there`}
                    </div>
                    <RadioFallback log={l} serviceCall={serviceCall} />
                  </li>
                ))}
              </ul>
            )}
            <Button variant="primary" onClick={() => void syncNow()} disabled={busy}>
              {busy ? "Syncing…" : "Sync now"}
            </Button>
          </Group>
        </>
      )}
    </Panel>
  );
}

function AttentionItem(props: { log: AttentionLog<QueueBody>; index: number; when: string }) {
  const l = props.log;
  const confirm = useConfirm();
  const toast = useToast();
  const [comment, setComment] = useState(l.body.comment ?? "");
  const [busy, setBusy] = useState(false);
  const edited = comment !== (l.body.comment ?? "");

  async function retry() {
    setBusy(true);
    try {
      const r = await retryAttentionLog(props.index, edited ? comment : undefined);
      toast(r.sent ? "Sent" : r.refused ? "Refused again" : "Queued; it goes when the connection allows");
    } finally {
      setBusy(false);
    }
  }
  async function discard() {
    const ok = await confirm({
      title: "Discard this log?",
      message: `The ${l.body.logType} log for ${what(l)} is removed from this device and never sent.`,
      confirmLabel: "Discard",
      danger: true,
    });
    if (ok) await discardAttentionLog(props.index);
  }

  const noteId = `outbox-note-${props.index}`;
  return (
    <li className="outbox-item">
      <div className="row">
        <Badge kind={l.body.logType}>{l.body.logType}</Badge>
        <span className="mono">{what(l)}</span>
      </div>
      <div className="muted fine">made {props.when}</div>
      <p className="inline-note bad" role="status">
        Refused: {l.reason}
      </p>
      <label htmlFor={noteId} className="fine">
        Comment
      </label>
      <textarea id={noteId} rows={2} value={comment} onChange={(e) => setComment(e.target.value)} />
      <div className="row">
        <Button variant="primary" onClick={() => void retry()} disabled={busy}>
          {edited ? "Save and retry" : "Retry"}
        </Button>
        <Button variant="danger" onClick={() => void discard()} disabled={busy}>
          Discard
        </Button>
      </div>
    </li>
  );
}

/**
 * No data, but a radio: the APRS message that logs this from a handheld, sent to the instance's service call.
 * Once sent, the user takes it out of the queue so it is not logged twice.
 */
function RadioFallback(props: { log: QueuedLog<QueueBody>; serviceCall: string | null }) {
  const confirm = useConfirm();
  const text = radioLogText(props.log);
  if (!text || !props.serviceCall) return null;
  const sent = async () => {
    const ok = await confirm({
      title: "Sent by radio?",
      message: `This ${props.log.body.logType} log leaves the queue, so it is not logged twice. The radio message counts by the radio path's own rules.`,
      confirmLabel: "Sent, remove it",
    });
    if (ok) await removeQueuedLog(props.log.cacheId, props.log.queuedAt);
  };
  return (
    <Disclosure label="Send it from a radio">
      <CommandBlock label={`APRS message to ${props.serviceCall}`} command={text} />
      <Button variant="quiet" onClick={() => void sent()}>
        I sent it by radio
      </Button>
    </Disclosure>
  );
}
