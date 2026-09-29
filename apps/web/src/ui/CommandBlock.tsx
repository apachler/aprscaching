// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * CommandBlock — a shell command the reader runs elsewhere (on the gateway host), shown verbatim in mono
 * with a Copy button that reports whether the copy worked (clipboard access fails on insecure origins).
 */
import { useToast } from "./Toast.js";
import { copyText } from "./clipboard.js";

export function CommandBlock(props: { label: string; command: string }) {
  const toast = useToast();
  return (
    <figure className="cmd">
      <figcaption className="cmd-l">{props.label}</figcaption>
      <div className="cmd-row">
        <code className="cmd-c">{props.command}</code>
        <button
          className="cmd-copy"
          aria-label={`Copy: ${props.label}`}
          onClick={async () =>
            toast((await copyText(props.command)) ? "Command copied" : "Couldn't copy — select the text")
          }
        >
          Copy
        </button>
      </div>
    </figure>
  );
}
