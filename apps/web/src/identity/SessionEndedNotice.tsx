// SPDX-License-Identifier: AGPL-3.0-or-later
import { useFmt } from "../format.js";
import { Button, Panel } from "../ui/index.js";
import { endedNotice, type EndedReason } from "./accountNotices.js";

/**
 * Why the person was signed out: their account was suspended, or their callsign moved to its licensee or was
 * released by the sysop (the gateway says), or they erased the account themselves. Without it the app would drop them on the landing page without a
 * word. An account left with no callsign is offered its data; one with other callsigns, a sign-in.
 */
export function SessionEndedNotice(props: {
  ended: EndedReason;
  onClose: () => void;
  onSignIn: () => void;
  onData: () => void;
}) {
  const fmt = useFmt();
  const n = endedNotice(props.ended, (s) => fmt.date(s));
  return (
    <Panel title={n.title} onClose={props.onClose}>
      <p role="alert">{n.body}</p>
      <div className="row end wrap gap-2 mt-3">
        {n.action === "data" && (
          <>
            <Button onClick={props.onSignIn}>Sign in</Button>
            <Button variant="primary" onClick={props.onData}>
              Get or erase my data
            </Button>
          </>
        )}
        {n.action === "signin" && (
          <Button variant="primary" onClick={props.onSignIn}>
            Sign in
          </Button>
        )}
        {n.action === null && (
          <Button variant="primary" onClick={props.onClose}>
            OK
          </Button>
        )}
      </div>
    </Panel>
  );
}
