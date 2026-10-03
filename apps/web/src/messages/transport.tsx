// SPDX-License-Identifier: AGPL-3.0-or-later
import { Badge } from "../ui/index.js";

type Family = "air" | "net" | "mesh";

/** What each transport a message row records reads as, and the family that colours its chip's edge. */
const TRANSPORT: Record<string, { label: string; family: Family; rx: string; tx: string }> = {
  tnc: {
    label: "RF",
    family: "air",
    rx: "Heard on the air by a TNC on this instance's ingest box",
    tx: "Sent on the air by a TNC",
  },
  "browser-rf": {
    label: "Browser radio",
    family: "air",
    rx: "Heard by a radio connected to a browser",
    tx: "Sent from a radio connected to the browser",
  },
  meshcom: {
    label: "MeshCom",
    family: "mesh",
    rx: "Heard through a MeshCom node on this instance's ingest box",
    tx: "Sent through a MeshCom node",
  },
  meshtastic: { label: "Meshtastic", family: "mesh", rx: "Heard through Meshtastic", tx: "Sent through Meshtastic" },
  "aprs-is": { label: "APRS-IS", family: "net", rx: "Received from APRS-IS, over the internet", tx: "Sent to APRS-IS" },
  axudp: { label: "AXUDP", family: "net", rx: "Received over an AXUDP link, over the internet", tx: "Sent over AXUDP" },
  axip: { label: "AXIP", family: "net", rx: "Received over an AXIP link, over the internet", tx: "Sent over AXIP" },
  unknown: { label: "Other", family: "net", rx: "Received on an ingest port the gateway does not know", tx: "Sent" },
};

/**
 * The network that carried a message, as a chip: its name in words, with a coloured edge for on the air, MeshCom
 * or the internet. A row stored without a transport shows none.
 */
export function TransportBadge(props: { transport?: string | null; direction?: string }) {
  const t = props.transport ? TRANSPORT[props.transport] : undefined;
  if (!t) return null;
  return (
    <Badge kind={`via via-${t.family}`} title={props.direction === "tx" ? t.tx : t.rx}>
      {t.label}
    </Badge>
  );
}
