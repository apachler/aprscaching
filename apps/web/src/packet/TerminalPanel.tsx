// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * TerminalPanel — the packet terminal as a dedicated WIDE workspace surface. Opened from the
 * shack; fills the content area at ≥1024px (the map hides) so the
 * multi-channel terminal, active window and monitor get room to lay out as columns — a real workspace,
 * not a slim drawer squeezed beside a map.
 */
import { Panel, Icon } from "../ui/index.js";
import { PacketTerminal } from "./PacketTerminal.js";

export function TerminalPanel(props: { callsign: string; verified: boolean; onClose: () => void }) {
  return (
    <Panel
      title={
        <>
          <Icon name="radio" cp437="" className="lead-ic" />
          Packet terminal
        </>
      }
      onClose={props.onClose}
      wide
    >
      <PacketTerminal callsign={props.callsign} verified={props.verified} />
    </Panel>
  );
}
