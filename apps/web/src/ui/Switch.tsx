// SPDX-License-Identifier: AGPL-3.0-or-later
/** An accessible on/off switch (use this, not a checkbox, to enable a feature or group). */
export function Switch(props: {
  checked: boolean;
  onChange?: (v: boolean) => void;
  disabled?: boolean;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={props.checked}
      aria-label={props.label}
      className={`sw${props.checked ? " on" : ""}`}
      disabled={props.disabled}
      onClick={() => !props.disabled && props.onChange?.(!props.checked)}
    >
      <span className="knob" aria-hidden="true" />
    </button>
  );
}
