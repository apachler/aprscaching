// SPDX-License-Identifier: AGPL-3.0-or-later
import { useEffect, useRef, useState } from "react";
import { runSync, syncStatus } from "../offline/sync.js";
import { statusLine, type SyncStatus } from "../offline/syncEngine.js";

const EMPTY: SyncStatus = { queued: 0, elsewhere: 0, attention: 0, oldestPack: null };

/**
 * Keep the app's offline state in sync (offline/sync.ts): on mount, whenever the connection returns, and when
 * a backed-off log comes due. `onSynced` runs after a sync sent something or refreshed a pack (the map
 * re-reads). Returns the state and the status line the top bar shows.
 */
export function useSync(onSynced: () => void): { status: SyncStatus; line: string } {
  const [status, setStatus] = useState<SyncStatus>(EMPTY);
  const synced = useRef(onSynced);
  useEffect(() => {
    synced.current = onSynced;
  });
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const reread = () => void syncStatus().then(setStatus);
    const sync = async () => {
      clearTimeout(timer);
      const r = await runSync();
      reread();
      if (r.sent || r.refreshed) synced.current();
      if (r.nextAt != null) timer = setTimeout(() => void sync(), Math.max(1000, r.nextAt - Date.now()));
    };
    void sync();
    const online = () => void sync();
    window.addEventListener("online", online);
    window.addEventListener("acs-queued", reread);
    window.addEventListener("acs-packs", reread);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("online", online);
      window.removeEventListener("acs-queued", reread);
      window.removeEventListener("acs-packs", reread);
    };
  }, []);
  return { status, line: statusLine(status) };
}
