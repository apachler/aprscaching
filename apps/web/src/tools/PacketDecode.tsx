// SPDX-License-Identifier: AGPL-3.0-or-later
import { aprsFields, type AprsDecodeResult } from "@aprscaching/tools";
import { Badge, Card, Hint } from "../ui/index.js";
import { TERMS } from "../terms.js";

/** A line to try the packet decoder on: a mobile position heard on RF and gated by OE8XXX. */
export const PACKET_SAMPLE = "OE8APR-9>APRS,WIDE1-1,qAR,OE8XXX:!4704.41N/01526.27E>088/036/A=001234Mobile";

const VIA: Record<string, { label: string; hint: string }> = {
  rf: { label: "RF", hint: "Heard on the air by the IGate named in the q-construct" },
  aprs_is: { label: "APRS-IS", hint: "Entered APRS-IS over the internet, not heard on the air" },
};

/**
 * PacketDecode — the packet decoder's result as fields: the AX.25 header (source, destination, path, how the
 * line arrived) and every APRS field, two columns once the panel is wide. An error says what is wrong.
 */
export function PacketDecode(props: { result: AprsDecodeResult }) {
  const r = props.result;
  if (!r.ok)
    return (
      <p className="error" role="alert">
        {r.error}
      </p>
    );
  const via = VIA[r.frame.heardVia] ?? { label: r.frame.heardVia, hint: "How the line says the packet arrived" };
  return (
    <Card className="decoded" aria-live="polite">
      <div className="row between">
        <strong className="mono">{r.frame.src}</strong>
        <Badge title={via.hint}>{via.label}</Badge>
      </div>
      <div className="muted">
        →{" "}
        <Hint text={TERMS.tocall}>
          <span className="mono">{r.frame.dst}</span>
        </Hint>{" "}
        · <span className="mono">{r.frame.path.join(" · ") || "(no path)"}</span>
      </div>
      <div className="kind">{r.data.kind}</div>
      <dl className="fields">
        {aprsFields(r.data).map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
    </Card>
  );
}
