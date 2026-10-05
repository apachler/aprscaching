// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * FilePick — the one file chooser: a button in the app's own look that names the chosen file, over the browser's
 * file input. The input stays in the page (visually hidden), so the keyboard, screen readers and the browser's
 * own chooser work as they do for any file input; the label around it makes the whole button open it.
 */
import { useState, type Ref } from "react";
import { Icon } from "./Icon.js";

export function FilePick(props: {
  /** What the button says before a file is chosen. */
  label: string;
  accept?: string;
  disabled?: boolean;
  onPick: (file: File | null) => void;
  inputRef?: Ref<HTMLInputElement>;
}) {
  const [name, setName] = useState<string | null>(null);
  return (
    <label className={`filepick${props.disabled ? " disabled" : ""}`}>
      <input
        ref={props.inputRef}
        className="sr-only"
        type="file"
        accept={props.accept}
        disabled={props.disabled}
        onChange={(e) => {
          const f = e.target.files?.[0] ?? null;
          setName(f?.name ?? null);
          props.onPick(f);
        }}
      />
      <span className="filepick-btn">
        <Icon name="attach" cp437="" className="lead-ic" />
        {props.label}
      </span>
      <span className="filepick-name muted">{name ?? "No file chosen"}</span>
    </label>
  );
}
