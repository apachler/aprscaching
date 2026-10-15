// SPDX-License-Identifier: AGPL-3.0-or-later
import { Group, Icon, InfoTip } from "../ui/index.js";
import { TERMS } from "../terms.js";
import type { CoverageState } from "./CoverageLayer.js";
import { reachAt, reachText } from "./coverage.js";

/**
 * Radio coverage under the hide form's location picker: a master switch for the range circles on the map, the
 * line that says what reaches the pin, and the key to the circles. Off by default; the switch is remembered.
 */
export function CoverageGroup(props: {
  on: boolean;
  setOn: (v: boolean) => void;
  state: CoverageState;
  pin: { lat: number; lon: number } | null;
  radioOnly: boolean;
}) {
  const { state, pin } = props;
  const n = state.sites.length;
  const status = !props.on
    ? "off"
    : state.loading
      ? "loading"
      : state.problem
        ? "unavailable"
        : `${n} ${n === 1 ? "receiver" : "receivers"}`;
  const reach =
    pin && !state.loading && !state.problem ? reachText(reachAt(pin.lat, pin.lon, state.sites), props.radioOnly) : null;
  return (
    <Group
      title="Radio coverage"
      status={status}
      master={{ on: props.on, set: props.setOn }}
      help="Range circles on the map: where receiving stations hear a finder on the air."
    >
      <p className="coverage-line" role="status" aria-live="polite">
        {state.problem === "zoom" ? (
          <span className="muted">Zoom in to see the coverage around the pin.</span>
        ) : state.problem === "failed" ? (
          <span className="inline-note bad">Coverage did not load. Move the map to try again.</span>
        ) : state.loading ? (
          <span className="muted">Loading coverage…</span>
        ) : !pin ? (
          <span className="muted">Drop the pin to see what reaches it.</span>
        ) : reach ? (
          <span className={`inline-note${reach.tone === "ok" ? " ok" : ""}`}>
            <Icon name={reach.tone === "ok" ? "check" : "alert"} size={14} cp437={reach.tone === "ok" ? "√" : "!"} />{" "}
            {reach.call
              ? // the callsign in mono, kept on one line
                reach.text
                  .split(reach.call)
                  .flatMap((part, i) => (i ? [<code key={i}>{reach.call}</code>, part] : [part]))
              : reach.text}
          </span>
        ) : null}
      </p>
      <ul className="coverage-key" aria-label="Coverage key">
        <li>
          <i className="coverage-swatch attested" aria-hidden="true" />
          <span>Attested receiver: RF finds can reach Tier A</span>
          <InfoTip text={TERMS["attested-site"]} label="What is an attested receiver?" />
        </li>
        <li>
          <i className="coverage-swatch relay" aria-hidden="true" />
          <span>Digipeater or IGate: reaches the instance over APRS-IS, Tier C</span>
          <InfoTip text={TERMS.igate} label="What is an IGate?" />
        </li>
        <li>
          <i className="coverage-swatch estimated" aria-hidden="true" />
          <span>Dashed: no PHG or RNG sent, range estimated</span>
          <InfoTip text={TERMS.phg} label="What are PHG and RNG?" />
        </li>
      </ul>
      {state.truncated && <p className="muted fine">More receivers than the map shows at once; zoom in for all.</p>}
    </Group>
  );
}
