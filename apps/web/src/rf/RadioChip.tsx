// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * RadioChip — the browser radio link's state in the top bar, wherever the user is in the app: which radio is
 * connected, how many frames it heard and whether transmit is open, locked or off. It shows only while a radio is
 * connected or connecting, and opens the radio's settings.
 */
import { Button, Icon } from "../ui/index.js";
import { useRadioLink } from "./RadioLinkHost.js";
import { LINK_LABEL, txWord } from "./radioLink.js";

export function RadioChip(props: { onOpen: () => void }) {
  const s = useRadioLink();
  if (!s.link && !s.busy) return null;
  const label = s.link ? LINK_LABEL[s.link] : "Connecting radio";
  const tx = txWord(s);
  const hint = s.link
    ? `${label} connected in this browser: ${s.count} heard, ${
        tx === "TX locked" ? "transmit needs a verified callsign" : tx === "TX on" ? "transmit on" : "receive only"
      }. Open the radio settings.`
    : "A radio is connecting. Open the radio settings.";
  return (
    <Button className="idchip radio-chip" onClick={props.onOpen} hint={hint}>
      <Icon name="radio" size={15} cp437="" />
      <span className="radio-chip-x">{label}</span>
      {s.link && (
        <>
          <span className="radio-chip-n">{s.count} RX</span>
          <span className="radio-chip-x">· {tx}</span>
        </>
      )}
    </Button>
  );
}
