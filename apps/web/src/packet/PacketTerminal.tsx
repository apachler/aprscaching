// SPDX-License-Identifier: AGPL-3.0-or-later
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import {
  TerminalSession,
  parseAnsi,
  toAnsi,
  cp437Bytes,
  StationRegistry,
  TYPE_TAG,
  TYPE_COLOR_VAR,
  type StationType,
  type Transport,
  type AnsiLine,
} from "@aprsweb/packet";
import { expand as expandMacros, withNow, ScriptRunner, type ScriptSession, type SessionStep } from "@aprsweb/tools";
import type { Ax25Frame } from "@aprsweb/ax25";
import { SerialKissTransport, webSerialSupported } from "./serialKiss.js";
import { useFmt } from "../format.js";
import { useToolHost, feedHeard } from "../tools/host.js";
import { ToolPanels } from "../tools/ToolPanels.js";

/** The transport surface the terminal drives — the real Web Serial KISS link, or an injected sim. */
export interface TermTransport extends Transport {
  connect(baud?: number): Promise<void>;
  disconnect(): Promise<void>;
}
export type MakeTransport = (onFrame: (f: Ax25Frame) => void, onClose: (e?: Error) => void) => TermTransport;

/**
 * PacketTerminal — the Graphic-Packet-reborn web terminal: multi-channel connected-mode
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
  { key: "F2", label: "Hello", text: "Hello from {call} - {date}" },
  { key: "F3", label: "Bye", text: "73 de {call}, bye" },
  { key: "F4", label: "Help", text: "help" },
];

// Macro expansion is the shared Graphic-Packet/LinPac expander — same {token} set everywhere.
function expand(text: string, vars: { call: string; chan: string }): string {
  return expandMacros(text, withNow({ call: vars.call, mycall: vars.call, chan: vars.chan, peer: vars.chan }));
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
  return (
    <>
      {spans.map((s, i) => (
        <span key={i} style={ansiStyle(s.fg, s.bg, s.bold)}>
          {s.text}
        </span>
      ))}
    </>
  );
}

export function PacketTerminal(props: { callsign: string; makeTransport?: MakeTransport; autoConnect?: string }) {
  const [, forceRender] = useReducer((n) => n + 1, 0);
  const notify = useCallback(() => forceRender(), []);
  const fmt = useFmt();
  const host = useToolHost(); // shared Tool host — colourisers/panels targeting the "terminal" surface

  const sessionRef = useRef<TerminalSession | null>(null);
  const transportRef = useRef<TermTransport | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const namesRef = useRef(new StationRegistry());
  const runnerRef = useRef<ScriptRunner | null>(null); // GPAUTO scripted-session engine
  const disposeScriptSvc = useRef<null | (() => void)>(null); // teardown for the session.script host-service

  const [portOpen, setPortOpen] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [remoteCall, setRemoteCall] = useState("");
  const [cmd, setCmd] = useState("");
  const [viewMon, setViewMon] = useState(true); // GP: which "channel" the central window shows — true = channel 0 (monitor)
  const [ctext, setCtext] = useState(() => localStorage.getItem(LS_CTEXT) ?? "");
  const [macros] = useState(() => {
    try {
      return JSON.parse(localStorage.getItem(LS_MACROS) || "null") ?? DEFAULT_MACROS;
    } catch {
      return DEFAULT_MACROS;
    }
  });
  const announced = useRef(new Set<number>()); // channels we've auto-sent CTEXT to

  const myCall = props.callsign && props.callsign.length >= 3 ? props.callsign.toUpperCase() : "N0CALL-7";
  const session = sessionRef.current;

  // CTEXT: when a channel becomes connected and we haven't greeted it, send the connect-text once.
  useEffect(() => {
    const s = sessionRef.current;
    if (!s || !ctext.trim()) return;
    for (const ch of s.channels) {
      if (ch.state === "connected" && !announced.current.has(ch.id)) {
        announced.current.add(ch.id);
        s.send(ch.id, expand(ctext, { call: myCall, chan: ch.remoteCall }));
      }
    }
  });

  async function openPort() {
    if (!props.makeTransport && !webSerialSupported()) {
      setErr("Web Serial needs Chromium (desktop). Use the operator-local ingest otherwise.");
      return;
    }
    setErr(null);
    try {
      const make: MakeTransport = props.makeTransport ?? ((onF, onC) => new SerialKissTransport(onF, onC));
      const transport = make(
        (f) => sessionRef.current?.onFrame(f),
        (e) => {
          if (e) setErr(e.message);
          setPortOpen(false);
        },
      );
      const session = new TerminalSession(myCall, transport, notify, namesRef.current);
      await transport.connect(9600);
      transportRef.current = transport;
      sessionRef.current = session;

      // GPAUTO scripted-session engine: the terminal OWNS the connection and offers a generic
      // `session.script` service to tools; the sched-query tool supplies the steps + shows progress. The
      // host only routes — it has no idea what the script is (the §5f invariant applied to automation).
      const port: ScriptSession = {
        connect: (call) => session.connect(call),
        send: (id, text) =>
          session.send(
            id,
            expand(text, { call: myCall, chan: session.channels.find((c) => c.id === id)?.remoteCall ?? "" }),
          ),
        close: (id) => session.close(id),
        channelState: (id) => session.channels.find((c) => c.id === id)?.state,
        channelLines: (id) =>
          session.channels
            .find((c) => c.id === id)
            ?.lines.filter((l) => l.dir === "rx")
            .map((l) => l.text) ?? [],
      };
      const runner = new ScriptRunner(port);
      runnerRef.current = runner;
      disposeScriptSvc.current = host.registerHostService("session.script", (a) => {
        const steps = (a as { steps?: unknown }).steps;
        if (!Array.isArray(steps)) return null;
        runner.load(steps as SessionStep[], Date.now());
        return { ok: true };
      });

      pollRef.current = setInterval(() => {
        session.poll();
        const st = runnerRef.current?.tick(Date.now());
        if (st) host.hostEmit("session.progress", st); // sched-query tool subscribes + renders
      }, 1000);
      setPortOpen(true);
      notify();
    } catch (e) {
      setErr((e as Error).message);
    }
  }
  async function closePort() {
    if (pollRef.current) clearInterval(pollRef.current);
    disposeScriptSvc.current?.();
    disposeScriptSvc.current = null;
    runnerRef.current = null;
    await transportRef.current?.disconnect();
    transportRef.current = null;
    sessionRef.current = null;
    announced.current.clear();
    setPortOpen(false);
    setActiveId(null);
    notify();
  }
  useEffect(
    () => () => {
      if (pollRef.current) clearInterval(pollRef.current);
      disposeScriptSvc.current?.();
      void transportRef.current?.disconnect();
    },
    [],
  );

  // Simulator/demo convenience: when an injected transport + autoConnect are given (never in the real
  // Web Serial path), open the port and open a channel on mount so the surface renders populated.
  useEffect(() => {
    if (!props.makeTransport || !props.autoConnect) return;
    let cancelled = false;
    void (async () => {
      await openPort();
      if (cancelled) return;
      const s = sessionRef.current;
      if (s) {
        const id = s.connect(props.autoConnect!.trim().toUpperCase());
        setActiveId(id);
        setViewMon(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function connect() {
    const s = sessionRef.current;
    if (!s || remoteCall.trim().length < 3) return;
    const id = s.connect(remoteCall.trim().toUpperCase());
    setActiveId(id);
    setViewMon(false);
    setRemoteCall(""); // switch the window to the new channel
  }
  function sendCmd(text?: string) {
    const s = sessionRef.current;
    if (!s || activeId == null) return;
    const line = text ?? cmd;
    if (!line) return;
    s.send(activeId, expand(line, { call: myCall, chan: active?.remoteCall ?? "" }));
    if (text === undefined) setCmd("");
  }

  const active = session?.channels.find((c) => c.id === activeId) ?? session?.channels[0];
  const activeIx = active && session ? session.channels.findIndex((c) => c.id === active.id) + 1 : 0; // GP channel #
  const monitor = session?.monitor ?? [];

  // Feed every newly-heard frame to the tool host as a heard-frame source — so
  // mheard/watch-alert record RF traffic even when the Monitor pane isn't the active view.
  const fedMon = useRef(0);
  useEffect(() => {
    if (monitor.length < fedMon.current) fedMon.current = 0; // TNC closed/reopened → monitor reset
    for (let i = fedMon.current; i < monitor.length; i++) feedHeard(monitor[i]!.src, "RF");
    fedMon.current = monitor.length;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- append-only scan keyed on length; monitor[i] by index is intentional
  }, [monitor.length]);

  // Export the current pane as classic colour ANSI art (.ans T3): the monitor as plain
  // phosphor lines, a connected channel with its ANSI colour preserved (parse → re-emit as SGR).
  function exportAns() {
    const lines: AnsiLine[] = viewMon
      ? monitor
          .slice(-500)
          .map(
            (m) =>
              `${TYPE_TAG[namesRef.current.classify(m.src, { dest: m.dst }) as StationType]} ${m.src}>${m.dst}  ${m.text}`,
          )
      : (active?.lines ?? []).map((l) =>
          parseAnsi(l.text).map((s) => ({ text: s.text, fg: s.fg ?? undefined, bg: s.bg ?? undefined, bold: s.bold })),
        );
    const bytes = cp437Bytes(toAnsi(lines, { fg: 10 }));
    const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: "application/octet-stream" }));
    const name = viewMon ? "monitor" : (active?.remoteCall ?? "channel").toLowerCase();
    const a = document.createElement("a");
    a.href = url;
    a.download = `aprscaching-${name}.ans`;
    a.click();
    URL.revokeObjectURL(url);
  }

  if (!props.makeTransport && !webSerialSupported()) {
    return (
      <p className="muted">
        The packet terminal needs Web Serial (Chromium desktop). On other devices, run the operator-local ingest.
      </p>
    );
  }

  return (
    <div className="packet-term" data-shell="terminal">
      <div className="row between pt-bar">
        <span className="muted">
          Station <span className="mono">{myCall}</span>
        </span>
        <span className="spacer" />
        {portOpen && (
          <button className="pt-ans" onClick={exportAns} title="Export this pane as ANSI art (.ans)">
            ↓ .ans
          </button>
        )}
        {portOpen ? (
          <button onClick={closePort}>Close TNC</button>
        ) : (
          <button className="primary" onClick={openPort}>
            Open KISS TNC…
          </button>
        )}
      </div>
      {err && <p className="error">{err}</p>}

      {portOpen && (
        <>
          {/* GP numbered channel bar (top): channel 0 = Monitor (all heard traffic), 1..N = connected-
              mode channels; a free slot's connect field sits inline. Click a slot to show it below. */}
          <div className="pt-chanbar" role="tablist">
            <button
              role="tab"
              aria-selected={viewMon}
              className={`pt-cbtn pt-cbtn-mon${viewMon ? " on" : ""}`}
              onClick={() => setViewMon(true)}
            >
              <span className="pt-ch-n">0</span> Monitor <span className="pt-count">{monitor.length}</span>
            </button>
            {session?.channels.map((ch, i) => (
              // tab + close are sibling real <button>s (a button can't nest inside a button, and the
              // close must be independently keyboard-reachable) wrapped in a presentational container.
              <span key={ch.id} className="pt-cbtn-wrap" role="presentation">
                <button
                  role="tab"
                  aria-selected={!viewMon && ch.id === active?.id}
                  className={`pt-cbtn st-${namesRef.current.classify(ch.remoteCall)}${!viewMon && ch.id === active?.id ? " on" : ""}`}
                  onClick={() => {
                    setViewMon(false);
                    setActiveId(ch.id);
                  }}
                >
                  <span className="pt-ch-n">{i + 1}</span> {ch.remoteCall}{" "}
                  <span className="pt-state">{ch.state[0]}</span>
                </button>
                <button
                  className="pt-x"
                  aria-label={`Close channel ${ch.remoteCall}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    session!.close(ch.id);
                  }}
                >
                  ✕
                </button>
              </span>
            ))}
            <div className="pt-connect-inline">
              <input
                value={remoteCall}
                placeholder="connect to…"
                aria-label="Connect to callsign"
                onChange={(e) => setRemoteCall(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") connect();
                }}
              />
              <button onClick={connect} disabled={remoteCall.trim().length < 3}>
                Connect
              </button>
            </div>
          </div>

          {/* the single central window — the selected channel, or channel 0 (monitor) */}
          <div className="pt-window">
            {viewMon ? (
              <pre className="pt-out pt-mon-out" aria-live="polite">
                {monitor.slice(-300).map((m, i) => {
                  const type = namesRef.current.classify(m.src, { dest: m.dst });
                  // let enabled `monitor` tools (surface: terminal) recolour or hide the line
                  let colorVar = TYPE_COLOR_VAR[type as StationType];
                  let hidden = false;
                  for (const fn of host.colourisers("terminal")) {
                    const c = fn({ src: m.src, dst: m.dst, text: m.text });
                    if (c) {
                      if (c.colorVar) colorVar = c.colorVar;
                      if (c.hidden) hidden = true;
                    }
                  }
                  if (hidden) return null;
                  return (
                    <div key={i} className="pt-mon-line">
                      <span className="pt-mon-tag" style={{ color: `var(${colorVar})` }}>
                        {TYPE_TAG[type as StationType]}
                      </span>{" "}
                      <span className="mono">
                        {m.src}&gt;{m.dst}
                      </span>
                      <span className="muted"> {fmt.ago(Math.floor(m.at / 1000))}</span>
                      <span className="pt-mon-text"> {m.text.slice(0, 120)}</span>
                    </div>
                  );
                })}
              </pre>
            ) : active ? (
              <pre className="pt-out" aria-live="polite">
                {active.lines.map((l, i) => (
                  <div key={i} className={`pt-line ${l.dir}`}>
                    <AnsiLine text={l.text} />
                  </div>
                ))}
              </pre>
            ) : (
              <p className="muted pt-empty">Connect to a BBS or node, or watch channel 0 (monitor).</p>
            )}

            <div className="pt-status mono">
              {viewMon ? (
                <>ch 0 · monitor · {monitor.length} fr</>
              ) : active ? (
                <>
                  ch {activeIx} · {active.remoteCall} · {active.state} · {active.lines.length} fr
                </>
              ) : (
                <>no channel</>
              )}
            </div>

            <div className="row gap-2 pt-cmd">
              <input
                value={cmd}
                placeholder={viewMon ? "select a channel (1–9) to type" : "send a line…"}
                aria-label="Send a line"
                onChange={(e) => setCmd(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") sendCmd();
                }}
                disabled={viewMon || !active || active.state !== "connected"}
              />
              <button onClick={() => sendCmd()} disabled={viewMon || !active || active.state !== "connected"}>
                Send
              </button>
            </div>
          </div>

          {/* function bar (GP bottom toolbar analog): F-key macros + connect-text */}
          <div className="pt-fnbar">
            <div className="pt-macros">
              {macros.map((m: { key: string; label: string; text: string }) => (
                <button
                  key={m.key}
                  className="pt-macro"
                  disabled={viewMon || !active || active.state !== "connected"}
                  title={m.text}
                  onClick={() => sendCmd(m.text)}
                >
                  {m.key} {m.label}
                </button>
              ))}
            </div>
            <details className="pt-ctext">
              <summary>CTEXT</summary>
              <input
                value={ctext}
                placeholder="Connect-text auto-sent on connect, e.g. Welcome {call}"
                onChange={(e) => {
                  setCtext(e.target.value);
                  localStorage.setItem(LS_CTEXT, e.target.value);
                }}
              />
            </details>
          </div>
        </>
      )}

      {/* panels contributed by enabled `panel`-tools that target the terminal surface */}
      <ToolPanels host={host} surface="terminal" />
    </div>
  );
}
