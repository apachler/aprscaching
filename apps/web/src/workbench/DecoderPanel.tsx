import { useState } from "react";
import { decodePacket, type DecodedPacket } from "../api.js";
import { Badge } from "../ui/index.js";

/**
 * DecoderPanel — paste a raw TNC2 / APRS-IS line and see the decoded AX.25 frame + parsed fields.
 * Pure workbench tool (no map, no session): the gateway's parser does the work. Its own surface.
 */
const SAMPLE = "OE8APR-9>APRS,WIDE1-1,qAR,OE8XXX:!4704.41N/01526.27E>088/036/A=001234Mobile";

export function DecoderPanel() {
  const [raw, setRaw] = useState("");
  const [decoded, setDecoded] = useState<DecodedPacket | null>(null);

  async function decode() {
    try { setDecoded(await decodePacket(raw.trim())); }
    catch (e) { setDecoded({ ok: false, error: (e as Error).message }); }
  }

  return (
    <>
      <p className="muted">Decode a raw packet — paste a TNC2 monitor line or an APRS-IS line.</p>
      <textarea value={raw} onChange={(e) => setRaw(e.target.value)} rows={3} placeholder="paste a raw TNC2 / APRS-IS line…" />
      <div className="row between mt-2">
        <button className="link" onClick={() => setRaw(SAMPLE)}>use a sample</button>
        <button className="primary" onClick={decode} disabled={!raw.trim()}>Decode</button>
      </div>
      {decoded && !decoded.ok && <p className="error">{decoded.error}</p>}
      {decoded?.ok && decoded.frame && (
        <div className="decoded">
          <div className="row between">
            <strong className="mono">{decoded.frame.src}</strong>
            <Badge kind={decoded.frame.heardVia === "rf" ? "tierA" : undefined}>{decoded.frame.heardVia}</Badge>
          </div>
          <div className="muted">→ {decoded.frame.dst} · {decoded.frame.path.join(" · ") || "(no path)"}</div>
          <div className="kind">{String(decoded.data?.kind)}</div>
          <dl className="fields">
            {decoded.data && Object.entries(flatten(decoded.data)).map(([k, v]) => (<div key={k}><dt>{k}</dt><dd>{v}</dd></div>))}
          </dl>
        </div>
      )}
    </>
  );
}

function flatten(data: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(data)) {
    if (k === "kind") continue;
    if (v == null) continue;
    if (typeof v === "object") {
      if (k === "symbol" && (v as { label?: string }).label) { out.symbol = `${(v as { label: string }).label} (${(v as { table: string }).table}${(v as { code: string }).code})`; continue; }
      out[k] = JSON.stringify(v);
    } else out[k] = String(v);
  }
  return out;
}
