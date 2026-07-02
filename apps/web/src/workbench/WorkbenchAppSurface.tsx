// SPDX-License-Identifier: AGPL-3.0-or-later
import type maplibregl from "maplibre-gl";
import { Panel, Ico } from "../ui/index.js";
import { appById, type WorkbenchAppId } from "./apps.js";
import { TerminalPanel } from "../packet/TerminalPanel.js";
import { BbsPanel } from "../live/BbsPanel.js";
import { DecoderPanel } from "./DecoderPanel.js";
import { ToolsPanel } from "../tools/ToolsPanel.js";
import { RigControl } from "./RigControl.js";
import { RemoteControl } from "./RemoteControl.js";
import { NodePanel } from "./NodePanel.js";

/**
 * WorkbenchAppSurface — renders the launched workbench app in its OWN surface. Every workbench app
 * opens this way (the drawer is a pure launcher). Terminal & BBS bring their own Panel chrome; the
 * rest are wrapped in a Panel using the app registry's title + wide flag. One component, one path.
 */
export function WorkbenchAppSurface(props: {
  app: WorkbenchAppId; callsign: string; verified: boolean; map: maplibregl.Map | null; onClose: () => void;
}) {
  const { app, callsign, verified, map, onClose } = props;
  if (app === "terminal") return <TerminalPanel callsign={callsign} onClose={onClose} />;
  if (app === "bbs") return <BbsPanel callsign={callsign} onClose={onClose} />;

  const meta = appById(app);
  const inner =
    app === "decoder" ? <DecoderPanel />
    : app === "tools" ? <ToolsPanel callsign={callsign} verified={verified} />
    : app === "rig" ? (<><p className="muted">Tune your transceiver over Web Serial — the APRS frequency, a manual MHz, or a live spot's freq. Tuning only (no transmit).</p><RigControl /></>)
    : app === "remote" ? <RemoteControl callsign={callsign} verified={verified} map={map} />
    : app === "node" ? (<><p className="muted">Run a NET/ROM node + connected-mode digipeater with the classic sysop command set. The packet terminal connects to it.</p><NodePanel /></>)
    : null;

  return (
    <Panel title={<><Ico e={meta ? `${meta.emoji} ` : ""} />{meta?.title ?? "Workbench"}</>} onClose={onClose} wide={meta?.wide}>
      {inner}
    </Panel>
  );
}
