// SPDX-License-Identifier: AGPL-3.0-or-later
import { useEffect, useRef, useState } from "react";
import { attentionLogs, flushLogQueue, queuedLogs } from "../api.js";

export interface LogQueueState {
  /** Logs waiting to be sent. */
  queued: number;
  /** Logs the instance refused, waiting for the user to retry or discard them. */
  attention: number;
}

const counts = async (): Promise<LogQueueState> => ({
  queued: (await queuedLogs()).length,
  attention: (await attentionLogs()).length,
});

/**
 * Logs made offline wait in a local queue (log/logQueue.ts). Flush it on mount, whenever connectivity
 * returns, and when a log backed off after a server error comes due; `onFlushed` runs after a flush sent
 * something (the map re-reads). Returns the counts the top bar shows.
 */
export function useLogQueue(onFlushed: () => void): LogQueueState {
  const [state, setState] = useState<LogQueueState>({ queued: 0, attention: 0 });
  const flushed = useRef(onFlushed);
  useEffect(() => {
    flushed.current = onFlushed;
  });
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const sync = async () => {
      clearTimeout(timer);
      const res = await flushLogQueue();
      setState(await counts());
      if (res.sent) flushed.current();
      if (res.nextAt != null) timer = setTimeout(() => void sync(), Math.max(1000, res.nextAt - Date.now()));
    };
    void sync();
    const onq = () => void counts().then(setState);
    const online = () => void sync();
    window.addEventListener("online", online);
    window.addEventListener("acs-queued", onq);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("online", online);
      window.removeEventListener("acs-queued", onq);
    };
  }, []);
  return state;
}
