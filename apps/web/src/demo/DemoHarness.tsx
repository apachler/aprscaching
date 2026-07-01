/**
 * DemoHarness — a hardware-free design surface for the packet/BBS shells. Reached at `/?demo=packet`,
 * `/?demo=bbs`, or `/?demo=1` (both). Renders the REAL components wired to the in-process simulator
 * (loopback KISS peer + canned BBS API) so the UI can be designed and screenshotted without a TNC,
 * gateway, or sign-in. This is the bench the Stage-3 Cogmind "flip" (docs/24 / docs/25 P5) is built on.
 */
import { useEffect, useState } from "react";
import { PacketTerminal } from "../packet/PacketTerminal.js";
import { BbsPanel } from "../live/BbsPanel.js";
import { makeSimTransport } from "./simPeer.js";
import { installBbsSim } from "./simBbsApi.js";
import "../styles.css";

const ME = "OE8APR-7";

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
  useEffect(() => { installBbsSim(); setBbsReady(true); }, []);

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
