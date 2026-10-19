// SPDX-License-Identifier: AGPL-3.0-or-later
import { useId, useState } from "react";
import { browserTimeZone, validTimeZone } from "../format.js";

/**
 * The time zone override. The typed text is a draft and reaches the settings only once it is blank or a zone
 * Intl accepts: the prefixes typed on the way to "Europe/Vienna" ("E", "Eu") are not zones, and a stored
 * unknown zone would break every date on the page and on each device the account syncs to.
 */
export function TimeZoneField(props: { value: string; onApply: (tz: string) => void }) {
  const id = useId();
  const [draft, setDraft] = useState<{ base: string; text: string } | null>(null);
  const text = draft && draft.base === props.value ? draft.text : props.value;
  const invalid = text.trim() !== "" && validTimeZone(text) === "";
  return (
    <label>
      Time zone
      <input
        value={text}
        placeholder={`browser (${browserTimeZone()})`}
        aria-invalid={invalid || undefined}
        aria-describedby={invalid ? `${id}-msg` : undefined}
        onChange={(e) => {
          const next = e.target.value;
          setDraft({ base: props.value, text: next });
          if (next.trim() === "" || validTimeZone(next)) props.onApply(validTimeZone(next));
        }}
      />
      {invalid && (
        <span id={`${id}-msg`} className="muted error">
          Not a known time zone yet — use a name like Europe/Vienna, or leave it blank.
        </span>
      )}
    </label>
  );
}
