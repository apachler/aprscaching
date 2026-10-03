// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * CommandBlock — a shell command the reader runs elsewhere (on the gateway host), shown verbatim in mono
 * with a Copy button that reports whether the copy worked (clipboard access fails on insecure origins). It also
 * carries a snippet to paste elsewhere, such as the HTML that embeds a badge.
 */
import { useToast } from "./Toast.js";
import { copyText } from "./clipboard.js";

export function CommandBlock(props: {
  label: string;
  command: string;
  /** the toast once copied; a snippet that is not a command names itself */
  copied?: string;
}) {
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
            toast(
              (await copyText(props.command)) ? (props.copied ?? "Command copied") : "Couldn't copy — select the text",
            )
          }
        >
          Copy
        </button>
      </div>
    </figure>
  );
}
