// SPDX-License-Identifier: AGPL-3.0-or-later
import { useEffect, useState } from "react";
import { getMessages } from "../api.js";
import { usePoll } from "../ui/index.js";

const SEEN_KEY = "acs.messages.seen";
const POLL_MS = 60_000;

function readSeen(): number {
  try {
    return Number(localStorage.getItem(SEEN_KEY) ?? 0) || 0;
  } catch {
    return 0;
  }
}
function writeSeen(ts: number): void {
  try {
    localStorage.setItem(SEEN_KEY, String(ts));
  } catch {
    /* a private window keeps no record; the dot then shows until Messages is opened in this visit */
  }
}

/**
 * The nav destinations that need the user's attention, for the dots on the rail, the More sheet and the More tab:
 * `messages` when a message to the signed-in call arrived since Messages was last open, `settings` while the
 * signed-in call is not verified yet. Messages are checked once a minute while the page is visible.
 */
export function useAttention(o: {
  signedIn: boolean;
  callsign: string;
  verified: boolean;
  messagesOpen: boolean;
}): ReadonlySet<string> {
  const [newest, setNewest] = useState(0);
  const [seen, setSeen] = useState(readSeen);
  const base = o.callsign.toUpperCase().split("-")[0] ?? "";

  usePoll(
    (signal) => {
      void getMessages(false, null, 1, base)
        .then((r) => {
          if (!signal.aborted) setNewest(r.messages[0]?.ts ?? 0);
        })
        .catch(() => {
          /* offline or refused: keep the last answer */
        });
    },
    POLL_MS,
    { enabled: o.signedIn && base.length >= 3 },
  );

  // opening Messages marks everything up to the newest as seen
  useEffect(() => {
    if (!o.messagesOpen || newest <= seen) return;
    writeSeen(newest);
    setSeen(newest);
  }, [o.messagesOpen, newest, seen]);

  const out = new Set<string>();
  if (o.signedIn && newest > seen && !o.messagesOpen) out.add("messages");
  if (o.signedIn && !o.verified) out.add("settings");
  return out;
}
