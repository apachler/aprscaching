// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Logging a find from a radio: the instance's service call, and the one line that says what to send to it. The
 * call comes from the instance's public descriptor, or offline from the last pack downloaded; until one answers,
 * nothing names a call, so no placeholder is ever shown as if it were the real one.
 */
import { useEffect, useState } from "react";
import { getFedDescriptor, knownServiceCall } from "../api.js";
import { InfoTip } from "../ui/index.js";
import { TERMS } from "../terms.js";

let asked: Promise<string | null> | null = null;

function loadServiceCall(): Promise<string | null> {
  asked ??= getFedDescriptor()
    .then((d) => d.aprsCall)
    .catch(() => null)
    .then(async (c) => c ?? (await knownServiceCall().catch(() => null)))
    .then((c) => {
      if (!c) asked = null; // ask again next time instead of remembering the miss
      return c ? c.toUpperCase() : null;
    });
  return asked;
}

/** The instance's service call, or null while it is unknown. */
export function useServiceCall(): string | null {
  const [call, setCall] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void loadServiceCall().then((c) => {
      if (live) setCall(c);
    });
    return () => {
      live = false;
    };
  }, []);
  return call;
}

/** "Log from your radio: send FOUND AC-1234 to OE8APR-15" — shown once the service call is known. */
export function RadioLogHint(props: { code: string }) {
  const service = useServiceCall();
  if (!service || !props.code) return null;
  return (
    <p className="muted fine mt-2">
      Log from your radio: send <span className="mono">FOUND {props.code}</span> to{" "}
      <span className="mono">{service}</span>.{" "}
      <InfoTip text={TERMS["service-call"]} label="What is the service call?" />
    </p>
  );
}
