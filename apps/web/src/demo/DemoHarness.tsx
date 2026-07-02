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
import { TuiMonitor, type MonitorData } from "../workbench/TuiMonitor.js";
import { NavRail } from "../NavRail.js";
import { TopBar } from "../TopBar.js";
import { Ico } from "../ui/index.js";
import { makeSimTransport } from "./simPeer.js";
import { installBbsSim } from "./simBbsApi.js";
import { installBoxSim } from "./simBoxApi.js";
import { installSerialSim } from "./simSerial.js";
import "../styles.css";

const ME = "OE8APR-7";
const noop = () => {};

/** Canned live snapshot for the TUI-monitor demo surface (no gateway needed for screenshots). */
function sampleMonitor(): MonitorData {
  const now = Math.floor(Date.now() / 1000);
  return {
    stations: [
      { callsign: "OE8XBM-7", lat: 46.82, lon: 14.31, symbol: "/#", course: null, speedKn: null, altitudeM: 920, comment: "Dobratsch digi", lastSeen: now - 42, roles: ["digipeater"] },
      { callsign: "OE8APR-9", lat: 46.62, lon: 14.31, symbol: "/>", course: 210, speedKn: 34, altitudeM: 510, comment: "mobile", lastSeen: now - 65 },
      { callsign: "OE3ABC", lat: 48.2, lon: 16.37, symbol: "/-", course: null, speedKn: null, altitudeM: 190, comment: "home", lastSeen: now - 130 },
      { callsign: "OE5FLM-13", lat: 48.3, lon: 14.29, symbol: "/_", course: null, speedKn: null, altitudeM: 300, comment: "WX 7.8C 42%RH", lastSeen: now - 158, roles: ["weather"] },
      { callsign: "DL2XYZ", lat: 48.14, lon: 11.58, symbol: "/I", course: null, speedKn: null, altitudeM: 520, comment: "iGate", lastSeen: now - 205, roles: ["igate"] },
      { callsign: "OE8KTN-1", lat: 46.62, lon: 14.31, symbol: "/&", course: null, speedKn: null, altitudeM: 440, comment: "node", lastSeen: now - 240, roles: ["node"] },
      { callsign: "OE9ZZZ", lat: 47.27, lon: 9.6, symbol: "/'", course: 90, speedKn: 5, altitudeM: 1200, comment: null, lastSeen: now - 320 },
    ],
    spots: [
      { id: "p1", source: "pota", callsign: "OE8APR", ref: "AT-0042", name: "Nockberge", lat: 46.9, lon: 13.8, freqHz: 14_285_000, mode: "SSB", band: "20m", spottedAt: now - 90 },
      { id: "s1", source: "sota", callsign: "OE8XBM", ref: "OE/KT-018", name: "Dobratsch", lat: 46.75, lon: 13.67, freqHz: 145_500_000, mode: "FM", band: "2m", spottedAt: now - 160 },
      { id: "p2", source: "pota", callsign: "DL2XYZ", ref: "DE-0221", lat: 48.1, lon: 11.5, freqHz: 7_144_000, mode: "SSB", band: "40m", spottedAt: now - 300 },
    ],
    ports: [
      { port: "APRS-IS", rx: 1284, tx: 0, lastBucket: now },
      { port: "KISS-TCP", rx: 96, tx: 12, lastBucket: now },
      { port: "Meshtastic", rx: 31, tx: 4, lastBucket: now },
    ],
  };
}

// The real desktop 3-pane shell (top bar + nav rail + map + docked panel), so the surfaces are shown
// at their true docked width in context — the panel is a fixed ~392px column beside the map, by design.
function AppShell({ active, title, children, childIsPanel, wide }: { active: string; title: ReactNode; children: ReactNode; childIsPanel?: boolean; wide?: boolean }) {
  return (
    <div className="app" style={{ height: "100dvh" }}>
      {/* the REAL top bar with the demo operator's chip, matching the signed-in teaser frames so every
          teaser frame shares identical chrome (ui-ux §6). Handlers are no-ops in the harness. */}
      <TopBar callsign={ME} verified={true} onAccount={noop} onHide={noop} count={7} queued={0}
              onFilters={noop} filtered={false} q="" onSearch={noop} onSearchSubmit={noop}
              onPickCache={noop} onPickStation={noop} onNearby={noop} onActivity={noop} onProfile={noop} />
      <div className="shell">
        <NavRail active={active} onMap={noop} onNearby={noop} onActivity={noop} onMessages={noop} onRanks={noop}
                 onWorkbench={noop} onProfile={noop} onSettings={noop} />
        <div className="mapwrap"><div className="map" style={{ background: "var(--surface-2)" }} /></div>
        {childIsPanel ? children : (
          <aside className={`panel right${wide ? " panel-wide" : ""}`} data-shell={wide ? "terminal" : undefined}>
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
      <AppShell active="workbench" title={<><Ico e="📻 " />Packet terminal</>} wide>
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
    return <AppShell active="workbench" title={<><Ico e="🎚 " />Rig control (CAT)</>}><RigControl /></AppShell>;
  }
  if (which === "app-remote") {
    return <AppShell active="workbench" title={<><Ico e="🛰 " />Remote control — your box</>}><RemoteControl callsign={ME} verified map={null} /></AppShell>;
  }
  if (which === "app-monitor") {
    return <AppShell active="workbench" title={<><Ico e="🖥 " />TUI monitor</>} wide><TuiMonitor callsign={ME} map={null} sample={sampleMonitor()} /></AppShell>;
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
          <aside className="panel right demo-surface" data-shell="terminal">
            <div className="row between"><h2><Ico e="📻 " />Packet terminal</h2><span className="spacer" /></div>
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
