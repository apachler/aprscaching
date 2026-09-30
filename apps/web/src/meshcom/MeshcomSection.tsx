// SPDX-License-Identifier: AGPL-3.0-or-later
import { useEffect, useState } from "react";
import { getMeshcomNodes, type MeshcomNode } from "../api.js";
import { useFmt } from "../format.js";
import { batteryText, deviceText, meshmapUrl, MESHMAP_ATTRIBUTION, signalText, viaText } from "./meshcomView.js";

/**
 * The station panel's MeshCom section: the device, battery, how and when this instance's MeshCom node last
 * heard the station, and the signal. Nothing shows for a station no MeshCom node heard. Signed-in members
 * see the exact battery and signal figures; visitors see them in words.
 */
export function MeshcomSection(props: { callsign: string }) {
  const fmt = useFmt();
  const [node, setNode] = useState<MeshcomNode | null>(null);
  useEffect(() => {
    let live = true;
    setNode(null);
    getMeshcomNodes(null, { call: props.callsign })
      .then((r) => live && setNode(r.nodes[0] ?? null))
      .catch(() => live && setNode(null));
    return () => {
      live = false;
    };
  }, [props.callsign]);
  if (!node) return null;
  const lines = [deviceText(node), batteryText(node), signalText(node)].filter(Boolean) as string[];
  return (
    <section className="mc-section mt-3" aria-label="MeshCom">
      <h4>MeshCom</h4>
      <p>
        {viaText(node)}, {fmt.ago(node.lastHeard)}
      </p>
      {lines.map((l) => (
        <p key={l} className="muted">
          {l}
        </p>
      ))}
      <p className="fine">
        <a href={meshmapUrl(node.callsign)} target="_blank" rel="noopener noreferrer">
          Open MeshMap
        </a>{" "}
        <span className="muted">({MESHMAP_ATTRIBUTION})</span>
      </p>
    </section>
  );
}
