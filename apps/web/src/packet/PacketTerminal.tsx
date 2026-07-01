import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { TerminalSession, parseAnsi, StationRegistry, TYPE_TAG, TYPE_COLOR_VAR, type StationType, type Transport } from "@aprsweb/packet";
import type { Ax25Frame } from "@aprsweb/ax25";
import { SerialKissTransport, webSerialSupported } from "./serialKiss.js";
import { useFmt } from "../format.js";

/** The transport surface the terminal drives — the real Web Serial KISS link, or an injected sim. */
export interface TermTransport extends Transport { connect(baud?: number): Promise<void>; disconnect(): Promise<void>; }
export type MakeTransport = (onFrame: (f: Ax25Frame) => void, onClose: (e?: Error) => void) => TermTransport;

/**
 * PacketTerminal (docs/25 P1) — the Graphic-Packet-reborn web terminal: multi-channel connected-mode
 * over Web Serial/KISS, a monitor pane, a per-channel status line, a function-key macro bar and a
 * command line. Built from semantic elements + theme tokens so the Stage-3 Cogmind flip is a token
 * swap (the channel windows become box-drawing green-screen panes, the monitor colourises by the
 * NAMES.GP type). Chromium-only (Web Serial); RX/TX stays operator-local and never touches the trust
 * tiers — this is workbench.
 */
const LS_MACROS = "acs.packet.macros";
const LS_CTEXT = "acs.packet.ctext";

const DEFAULT_MACROS: { key: string; label: string; text: string }[] = [
  { key: "F1", label: "CQ", text: "cq cq de {call} k" },
  { key: "F2", label: "Hello", text: "Hello from {call} — {date}" },
  { key: "F3", label: "Bye", text: "73 de {call}, bye" },
  { key: "F4", label: "Help", text: "help" },
];

function expand(text: string, vars: { call: string; chan: string }): string {
  return text.replace(/\{call\}/g, vars.call).replace(/\{chan\}/g, vars.chan)
    .replace(/\{date\}/g, new Date().toISOString().slice(0, 10));
}

function ansiStyle(fg: number | null, bg: number | null, bold: boolean): React.CSSProperties {
  const s: React.CSSProperties = {};
  if (fg != null) s.color = `var(--ansi-${fg})`;
  if (bg != null) s.background = `var(--ansi-${bg})`;
  if (bold) s.fontWeight = 700;
  return s;
}

/** Render a line of (possibly ANSI) text into coloured spans. */
function AnsiLine({ text }: { text: string }) {
  const spans = parseAnsi(text);
  if (spans.length === 0) return <>&nbsp;</>;
  return <>{spans.map((s, i) => <span key={i} style={ansiStyle(s.fg, s.bg, s.bold)}>{s.text}</span>)}</>;
}

export function PacketTerminal(props: { callsign: string; makeTransport?: MakeTransport; autoConnect?: string }) {
  const [, forceRender] = useReducer((n) => n + 1, 0);
  const notify = useCallback(() => forceRender(), []);
  const fmt = useFmt();

  const sessionRef = useRef<TerminalSession | null>(null);
  const transportRef = useRef<TermTransport | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const namesRef = useRef(new StationRegistry());

  const [portOpen, setPortOpen] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [remoteCall, setRemoteCall] = useState("");
  const [cmd, setCmd] = useState("");
  const [showMonitor, setShowMonitor] = useState(true);
  const [ctext, setCtext] = useState(() => localStorage.getItem(LS_CTEXT) ?? "");
  const [macros] = useState(() => {
    try { return JSON.parse(localStorage.getItem(LS_MACROS) || "null") ?? DEFAULT_MACROS; } catch { return DEFAULT_MACROS; }
  });
  const announced = useRef(new Set<number>()); // channels we've auto-sent CTEXT to

  const myCall = props.callsign && props.callsign.length >= 3 ? props.callsign.toUpperCase() : "N0CALL-7";
  const session = sessionRef.current;

  // CTEXT: when a channel becomes connected and we haven't greeted it, send the connect-text once.
  useEffect(() => {
    const s = sessionRef.current; if (!s || !ctext.trim()) return;
    for (const ch of s.channels) {
      if (ch.state === "connected" && !announced.current.has(ch.id)) {
        announced.current.add(ch.id);
        s.send(ch.id, expand(ctext, { call: myCall, chan: ch.remoteCall }));
      }
    }
  });

  async function openPort() {
    if (!props.makeTransport && !webSerialSupported()) { setErr("Web Serial needs Chromium (desktop). Use the operator-local ingest otherwise."); return; }
    setErr(null);
    try {
      const make: MakeTransport = props.makeTransport ?? ((onF, onC) => new SerialKissTransport(onF, onC));
      const transport = make((f) => sessionRef.current?.onFrame(f), (e) => { if (e) setErr(e.message); setPortOpen(false); });
      const session = new TerminalSession(myCall, transport, notify, namesRef.current);
      await transport.connect(9600);
      transportRef.current = transport; sessionRef.current = session;
      pollRef.current = setInterval(() => session.poll(), 1000);
      setPortOpen(true); notify();
    } catch (e) { setErr((e as Error).message); }
  }
  async function closePort() {
    if (pollRef.current) clearInterval(pollRef.current);
    await transportRef.current?.disconnect();
    transportRef.current = null; sessionRef.current = null; announced.current.clear();
    setPortOpen(false); setActiveId(null); notify();
  }
  useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current); void transportRef.current?.disconnect(); }, []);

  // Simulator/demo convenience: when an injected transport + autoConnect are given (never in the real
  // Web Serial path), open the port and open a channel on mount so the surface renders populated.
  useEffect(() => {
    if (!props.makeTransport || !props.autoConnect) return;
    let cancelled = false;
    void (async () => {
      await openPort();
      if (cancelled) return;
      const s = sessionRef.current;
      if (s) { const id = s.connect(props.autoConnect!.trim().toUpperCase()); setActiveId(id); }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function connect() {
    const s = sessionRef.current; if (!s || remoteCall.trim().length < 3) return;
    const id = s.connect(remoteCall.trim().toUpperCase());
    setActiveId(id); setRemoteCall("");
  }
  function sendCmd(text?: string) {
    const s = sessionRef.current; if (!s || activeId == null) return;
    const line = text ?? cmd;
    if (!line) return;
    s.send(activeId, expand(line, { call: myCall, chan: active?.remoteCall ?? "" }));
    if (text === undefined) setCmd("");
  }

  const active = session?.channels.find((c) => c.id === activeId) ?? session?.channels[0];
  const monitor = session?.monitor ?? [];

  if (!props.makeTransport && !webSerialSupported()) {
    return <p className="muted">The packet terminal needs Web Serial (Chromium desktop). On other devices, run the operator-local ingest.</p>;
  }

  return (
    <div className="packet-term" data-shell="terminal">
      <div className="row between pt-bar">
        <span className="muted">Station <span className="mono">{myCall}</span></span>
        {portOpen
          ? <button onClick={closePort}>Close TNC</button>
          : <button className="primary" onClick={openPort}>Open KISS TNC…</button>}
      </div>
      {err && <p className="error">{err}</p>}

      {portOpen && (
        <>
          {/* left pane: connect + channel list + connect-text */}
          <div className="pt-side">
            <div className="row gap-2 pt-connect">
              <input value={remoteCall} placeholder="connect to (e.g. OE8XBM-7)" onChange={(e) => setRemoteCall(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") connect(); }} />
              <button onClick={connect} disabled={remoteCall.trim().length < 3}>Connect</button>
            </div>
            {session && session.channels.length > 0 && (
              <div className="pt-tabs" role="tablist">
                {session.channels.map((ch) => (
                  <button key={ch.id} role="tab" aria-selected={ch.id === active?.id}
                    className={`pt-tab st-${namesRef.current.classify(ch.remoteCall)}${ch.id === active?.id ? " on" : ""}`}
                    onClick={() => setActiveId(ch.id)}>
                    {ch.remoteCall} <span className="pt-state">{ch.state[0]}</span>
                    <span className="pt-x" role="button" aria-label="close channel" onClick={(e) => { e.stopPropagation(); session.close(ch.id); }}>✕</span>
                  </button>
                ))}
              </div>
            )}
            <details className="pt-ctext">
              <summary>Connect-text (auto-sent on connect)</summary>
              <input value={ctext} placeholder="e.g. Welcome — {call} auto-greeter"
                onChange={(e) => { setCtext(e.target.value); localStorage.setItem(LS_CTEXT, e.target.value); }} />
            </details>
          </div>

          {/* centre pane: active channel window + command line + function-key macros */}
          <div className="pt-main">
            {active ? (
              <div className="pt-window">
                <pre className="pt-out" aria-live="polite">{active.lines.map((l, i) => (
                  <div key={i} className={`pt-line ${l.dir}`}><AnsiLine text={l.text} /></div>
                ))}</pre>
                <div className="pt-status mono">
                  {active.remoteCall} · {active.state} · {active.lines.length} lines
                </div>
                <div className="row gap-2 pt-cmd">
                  <input value={cmd} placeholder="send a line…" onChange={(e) => setCmd(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") sendCmd(); }} disabled={active.state !== "connected"} />
                  <button onClick={() => sendCmd()} disabled={active.state !== "connected"}>Send</button>
                </div>
                <div className="pt-macros">
                  {macros.map((m: { key: string; label: string; text: string }) => (
                    <button key={m.key} className="pt-macro" disabled={active.state !== "connected"}
                      title={m.text} onClick={() => sendCmd(m.text)}>{m.key} {m.label}</button>
                  ))}
                </div>
              </div>
            ) : <p className="muted pt-empty">Connect to a BBS or node to open a channel.</p>}
          </div>

          {/* right pane: monitor — all heard traffic, colourised by NAMES.GP type */}
          <div className="pt-mon">
            <button className="link pt-mon-toggle" aria-expanded={showMonitor} onClick={() => setShowMonitor((v) => !v)}>
              {showMonitor ? "▾" : "▸"} Monitor ({monitor.length})
            </button>
            {showMonitor && (
              <pre className="pt-mon-out">{monitor.slice(-200).map((m, i) => {
                const type = namesRef.current.classify(m.src, { dest: m.dst });
                return (
                  <div key={i} className="pt-mon-line">
                    <span className="pt-mon-tag" style={{ color: `var(${TYPE_COLOR_VAR[type as StationType]})` }}>{TYPE_TAG[type as StationType]}</span>
                    {" "}<span className="mono">{m.src}&gt;{m.dst}</span>
                    <span className="muted"> {fmt.ago(Math.floor(m.at / 1000))}</span>
                    <span className="pt-mon-text"> {m.text.slice(0, 80)}</span>
                  </div>
                );
              })}</pre>
            )}
          </div>
        </>
      )}
    </div>
  );
}
