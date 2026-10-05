// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * RadioChip — the browser radio link's state in the top bar, wherever the user is in the app: which radio is
 * connected, how many frames it heard and whether transmit is open, locked or receive-only. It shows while a radio
 * is connected or connecting, or while the packet terminal has a TNC open, and it flashes "TX" for every frame this
 * tab transmits; a polite live region says "Transmitted to …" at most once every few seconds. Selecting it opens
 * the radio's settings, or, while a transmit-capable radio waits for this session's consent, asks for it.
 */
import { useEffect, useState } from "react";
import { Button, Icon } from "../ui/index.js";
import { radioLink, useRadioLink } from "./RadioLinkHost.js";
import { LINK_LABEL, txWord } from "./radioLink.js";
import { TxAnnouncer } from "./txLog.js";

/** How long "TX" stays lit after the last outgoing frame. */
const TX_LIT_MS = 1500;

export function RadioChip(props: { onOpen: () => void }) {
  const s = useRadioLink();
  // the id of the frame that lit the indicator (0 = dark); a new id restarts the flash
  const [lit, setLit] = useState(0);
  const [said, setSaid] = useState("");
  useEffect(() => {
    let dark: ReturnType<typeof setTimeout> | undefined;
    const announcer = new TxAnnouncer(setSaid);
    const off = radioLink.onEvent((e) => {
      if (e.kind !== "tx") return;
      setLit(e.entry.id);
      clearTimeout(dark);
      dark = setTimeout(() => setLit(0), TX_LIT_MS);
      announcer.note(e.entry.to);
    });
    return () => {
      off();
      clearTimeout(dark);
      announcer.stop();
    };
  }, []);

  if (!s.link && !s.busy && !s.terminal) return null;
  const label = s.link ? LINK_LABEL[s.link] : s.busy ? "Connecting radio" : "Packet terminal";
  const tx = s.link ? txWord(s) : s.termTx ? "TX on" : s.verified ? "RX only" : "TX locked";
  // a transmit-capable radio under a verified callsign, without this session's consent yet
  const canGrant = s.verified && !s.txOn && (s.link === "serial" || s.link === "ble");
  const hint = canGrant
    ? `${label} connected in this browser: ${s.count} heard, receive only. Select to allow transmitting until you close this tab.`
    : s.link
      ? `${label} connected in this browser: ${s.count} heard, ${
          tx === "TX locked" ? "transmit needs a verified callsign" : tx === "TX on" ? "transmit on" : "receive only"
        }. Open the radio settings.`
      : s.busy
        ? "A radio is connecting. Open the radio settings."
        : `The packet terminal has ${s.terminal ?? "a TNC"} open, ${tx === "TX on" ? "transmit on" : "receive only"}. Open the radio settings.`;
  return (
    <>
      <Button
        className="idchip radio-chip"
        onClick={() => (canGrant ? void radioLink.requestTx() : props.onOpen())}
        hint={hint}
      >
        <Icon name="radio" size={15} cp437="" />
        <span className="radio-chip-x">{label}</span>
        {s.link && <span className="radio-chip-n">{s.count} RX</span>}
        {(s.link || s.terminal) && <span className="radio-chip-x">· {tx}</span>}
        {lit > 0 && (
          <span key={lit} className="radio-chip-tx" aria-hidden="true">
            TX
          </span>
        )}
      </Button>
      <span className="sr-only" role="status" aria-live="polite">
        {said}
      </span>
    </>
  );
}
