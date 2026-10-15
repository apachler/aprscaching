// SPDX-License-Identifier: AGPL-3.0-or-later
import { useId, useState } from "react";
import { Advanced, Button, InfoTip, Row } from "../ui/index.js";
import { radioLink, useRadioLink } from "./RadioLinkHost.js";
import {
  KISS_TIMING_DEFAULTS,
  KISS_TIMING_FIELDS,
  isDefaultKissTiming,
  kissValueText,
  parseKissValue,
  type KissTimingField,
} from "./kissTiming.js";

/**
 * My radio → Advanced: the channel access a USB or Bluetooth KISS TNC is sent as it connects (TXDELAY, PERSIST,
 * SLOTTIME). A value takes effect when the field is left; with a TNC connected it is sent at once.
 */
export function KissTimingSettings() {
  const { kissTiming, link } = useRadioLink();
  const kissLink = link === "serial" || link === "ble";
  return (
    <Advanced label="Advanced: TNC timing">
      <p className="muted fine m-0">
        {kissLink
          ? "Sent to your TNC as it connects; a change is sent right away."
          : "Sent to a USB or Bluetooth TNC as it connects. The soundcard modem and a Meshtastic node take none."}
      </p>
      {KISS_TIMING_FIELDS.map((f) => (
        <TimingField key={f.key} field={f} value={kissTiming[f.key]} />
      ))}
      <div className="row end">
        <Button
          onClick={() => radioLink.setKissTiming(KISS_TIMING_DEFAULTS)}
          disabled={isDefaultKissTiming(kissTiming)}
          hint="TX delay 30 (300 ms), persist 63, slot time 10 (100 ms): the values for APRS"
        >
          Reset to defaults
        </Button>
      </div>
    </Advanced>
  );
}

/** One setting: a whole number 0–255, checked as it is typed and saved when the field is left. */
function TimingField(props: { field: KissTimingField; value: number }) {
  const f = props.field;
  const id = useId();
  // the draft follows the stored value until the person edits it
  const [draft, setDraft] = useState<{ base: number; text: string } | null>(null);
  const text = draft && draft.base === props.value ? draft.text : String(props.value);
  const parsed = parseKissValue(text);
  // an invalid value stays in the field with its message until it is corrected
  const commit = () => {
    if (parsed === null) return;
    radioLink.setKissTiming({ [f.key]: parsed });
    setDraft(null);
  };
  return (
    <Row
      label={
        <>
          <label htmlFor={id}>{f.label}</label> <InfoTip text={f.hint} label={`What is ${f.label}?`} />
        </>
      }
      help={
        parsed === null ? (
          <span id={`${id}-msg`} className="error" role="alert">
            Enter a whole number from 0 to 255.
          </span>
        ) : (
          <span id={`${id}-msg`}>
            {kissValueText(f.key, parsed)} · default {KISS_TIMING_DEFAULTS[f.key]}
          </span>
        )
      }
    >
      <input
        id={id}
        className="field-sm mono"
        type="number"
        inputMode="numeric"
        min={0}
        max={255}
        step={1}
        value={text}
        aria-invalid={parsed === null || undefined}
        aria-describedby={`${id}-msg`}
        onChange={(e) => setDraft({ base: props.value, text: e.target.value })}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
        }}
      />
    </Row>
  );
}
