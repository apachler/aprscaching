// SPDX-License-Identifier: AGPL-3.0-or-later
import { useEffect, useRef, useState } from "react";
import { flushLogQueue, queuedLogCount } from "../api.js";

/**
 * Finds logged while offline wait in a local queue. Flush it on mount and whenever connectivity
 * returns; `onFlushed` runs after a flush sent something (the map re-reads). Returns the number of
 * finds still queued, which the top bar shows.
 */
export function useLogQueue(onFlushed: () => void): number {
  const [queued, setQueued] = useState(queuedLogCount());
  const flushed = useRef(onFlushed);
  useEffect(() => {
    flushed.current = onFlushed;
  });
  useEffect(() => {
    const sync = async () => {
      if (await flushLogQueue()) {
        setQueued(queuedLogCount());
        flushed.current();
      }
    };
    void sync();
    const onq = () => setQueued(queuedLogCount());
    window.addEventListener("online", sync);
    window.addEventListener("acs-queued", onq);
    return () => {
      window.removeEventListener("online", sync);
      window.removeEventListener("acs-queued", onq);
    };
  }, []);
  return queued;
}
