// SPDX-License-Identifier: AGPL-3.0-or-later
import { DXCC_ENTITIES, dxccEntity } from "@aprscaching/shared";

/** A cache's country as hams name it: the DXCC prefix with the entity's name, `OE · Austria`. */
export const countryLabel = (prefix: string): string => {
  const e = dxccEntity(prefix);
  return e ? `${e.prefix} · ${e.name}` : prefix;
};

/** The country picker of the hide and edit forms: every DXCC entity by name, stored as its prefix. */
export function CountrySelect(props: { value: string; onChange: (prefix: string) => void; optional?: boolean }) {
  return (
    <label>
      Country {props.optional && <span className="muted">(optional)</span>}
      <select value={props.value} onChange={(e) => props.onChange(e.target.value)}>
        <option value="">None</option>
        {DXCC_ENTITIES.map((e) => (
          <option key={e.prefix} value={e.prefix}>
            {e.name} · {e.prefix}
          </option>
        ))}
      </select>
    </label>
  );
}
