// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * UpdateNotice — a quiet bar when a new version of the app is ready. The user decides when to reload,
 * so an update never interrupts a hunt; "Later" hides it until the next start.
 */
import { useEffect, useState } from "react";
import { Button } from "../ui/index.js";
import { UPDATE_EVENT, applyUpdate, updateWaiting } from "./serviceWorker.js";

export function UpdateNotice() {
  const [ready, setReady] = useState(updateWaiting);
  const [later, setLater] = useState(false);
  useEffect(() => {
    const on = () => setReady(true);
    window.addEventListener(UPDATE_EVENT, on);
    return () => window.removeEventListener(UPDATE_EVENT, on);
  }, []);
  if (!ready || later) return null;
  return (
    <div className="update-notice" role="status">
      <span>A new version of APRScaching is ready.</span>
      <Button variant="primary" onClick={applyUpdate}>
        Reload
      </Button>
      <Button variant="quiet" onClick={() => setLater(true)}>
        Later
      </Button>
    </div>
  );
}
