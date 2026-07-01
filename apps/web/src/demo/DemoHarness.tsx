/**
 * DemoHarness — a hardware-free design surface for the packet/BBS shells. Reached at `/?demo=packet`,
 * `/?demo=bbs`, or `/?demo=1` (both). Renders the REAL components wired to the in-process simulator
 * (loopback KISS peer + canned BBS API) so the UI can be designed and screenshotted without a TNC,
 * gateway, or sign-in. This is the bench the Stage-3 Cogmind "flip" (docs/24 / docs/25 P5) is built on.
 */
import { useEffect, useState, type ReactNode } from "react";
import { PacketTerminal } from "../packet/PacketTerminal.js";
import { BbsPanel } from "../live/BbsPanel.js";
import { RigControl } from "../workbench/RigControl.js";
import { RemoteControl } from "../workbench/RemoteControl.js";
import { NavRail } from "../NavRail.js";
import { TopBar } from "../TopBar.js";
import { makeSimTransport } from "./simPeer.js";
import { installBbsSim } from "./simBbsApi.js";
import { installBoxSim } from "./simBoxApi.js";
import { installSerialSim } from "./simSerial.js";
import "../styles.css";

const ME = "OE8APR-7";
const noop = () => {};

// The real desktop 3-pane shell (top bar + nav rail + map + docked panel), so the surfaces are shown
// at their true docked width in context — the panel is a fixed ~392px column beside the map, by design.
function AppShell({ active, title, children, childIsPanel, wide }: { active: string; title: string; children: ReactNode; childIsPanel?: boolean; wide?: boolean }) {
  return (
    <div className="app" style={{ height: "100dvh" }}>
      {/* the REAL top bar with the demo operator's chip, matching the signed-in teaser frames so every
          teaser frame shares identical chrome (ui-ux §6). Handlers are no-ops in the harness. */}
      <TopBar callsign={ME} verified={false} onAccount={noop} onHide={noop} count={7} queued={0}
              onFilters={noop} filtered={false} q="" onSearch={noop} onSearchSubmit={noop}
              onPickCache={noop} onPickStation={noop} onNearby={noop} onActivity={noop} onProfile={noop} />
      <div className="shell">
        <NavRail active={active} onMap={noop} onNearby={noop} onActivity={noop} onMessages={noop} onRanks={noop}
                 onWorkbench={noop} onProfile={noop} onSettings={noop} />
        <div className="mapwrap"><div className="map" style={{ background: "var(--surface-2)" }} /></div>
        {childIsPanel ? children : (
          <aside className={`panel right${wide ? " panel-wide" : ""}`}>
            <div className="row between"><h2>{title}</h2><span className="spacer" /><button className="icon" aria-label="Close">✕</button></div>
            {children}
          </aside>
        )}
      </div>
    </div>
  );
}

// Neutralise the app's absolute/docked .panel positioning so each surface sizes to its content for the
// side-by-side harness (BbsPanel renders its own .panel; PacketTerminal is wrapped in one below).
const HARNESS_CSS = `
  .demo-surface > .panel, .demo-surface.panel { position: static; inset: auto; width: 348px; max-width: 348px; height: auto; box-shadow: none; }
  .demo-surface, .demo-surface * { min-width: 0; }
  .demo-surface .pt-out, .demo-surface .pt-mon-out { overflow: auto; max-width: 100%; }
`;

export function DemoHarness({ which }: { which: string }) {
  const showPacket = which === "packet" || which === "1" || which === "both" || which === "";
  const showBbs = which === "bbs" || which === "1" || which === "both" || which === "";
  const [bbsReady, setBbsReady] = useState(false);
  // Install the fetch/serial sims SYNCHRONOUSLY (useState initialiser) so catSupported() and the box
  // log see them on the very first render — a useEffect would flash the un-simulated fallback first.
  useState(() => {
    if (which === "app-rig") installSerialSim();
    if (which === "app-remote") { installBoxSim(); try { localStorage.setItem("acs.boxId", "pi-home"); } catch { /* ignore */ } }
    return null;
  });
  useEffect(() => { installBbsSim(); setBbsReady(true); }, []);

  // Full-app-shell variants: the surface docked in the real 3-pane desktop layout (header + rail + map).
  if (which === "app-packet") {
    return (
      <AppShell active="workbench" title="📻 Packet terminal" wide>
        <PacketTerminal callsign={ME} makeTransport={makeSimTransport(ME)} autoConnect="OE8XBM-7" />
      </AppShell>
    );
  }
  if (which === "app-bbs") {
    return <AppShell active="bbs" title="✉ BBS" childIsPanel>{bbsReady && <BbsPanel callsign={ME} onClose={noop} />}</AppShell>;
  }
  if (which === "app-rig") {
    // A demo operator with a control-verified callsign, so the connected tune UI is shown (RX-side,
    // no H5 gate on tuning). The fake serial port is already installed above.
    return <AppShell active="workbench" title="🎚 Rig control (CAT)"><RigControl /></AppShell>;
  }
  if (which === "app-remote") {
    return <AppShell active="workbench" title="🛰 Remote control — your box"><RemoteControl callsign={ME} verified map={null} /></AppShell>;
  }

  return (
    <div className="app" style={{ minHeight: "100dvh", background: "var(--surface)", padding: 20 }}>
      <style>{HARNESS_CSS}</style>
      <header style={{ marginBottom: 14 }}>
        <h1 style={{ margin: 0, fontSize: 20 }}>Design harness — simulator</h1>
        <p className="muted" style={{ margin: "4px 0 0" }}>
          Real components, no hardware. The packet terminal is wired to a loopback BBS peer; BBS shows canned mail.
          Try <code>?demo=packet</code>, <code>?demo=bbs</code>, or <code>?demo=1</code> for both.
        </p>
      </header>
      <div style={{ display: "flex", gap: 20, alignItems: "flex-start", flexWrap: "wrap" }}>
        {showPacket && (
          <aside className="panel right demo-surface">
            <div className="row between"><h2>📻 Packet terminal</h2><span className="spacer" /></div>
            <PacketTerminal callsign={ME} makeTransport={makeSimTransport(ME)} autoConnect="OE8XBM-7" />
          </aside>
        )}
        {showBbs && bbsReady && (
          <div className="demo-surface">
            <BbsPanel callsign={ME} onClose={() => {}} />
          </div>
        )}
      </div>
    </div>
  );
}
