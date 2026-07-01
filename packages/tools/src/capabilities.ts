/**
 * capabilities.ts — the Tool permission model (docs/27 B.3). A Tool declares the capabilities it needs
 * in its manifest; the host grants them (the user approves imported tools). A Tool can ONLY reach a
 * host-API surface it was granted — no ambient network/DOM/FS. The three GATED capabilities carry extra
 * weight: 'tx' additionally passes the existing H5 / control-verification TX gate at call time, and a
 * Tool can NEVER bypass verify.ts trust.
 */
export type Capability =
  | "command"   // register a /word in the terminal/BBS
  | "monitor"   // read heard frames + contribute monitor colourisers/filters
  | "event"     // hook lifecycle events (on_connect/on_find/on_spot/…)
  | "decoder"   // contribute an audio/signal decoder (PSK31/CW/…)
  | "panel"     // add a small workbench panel/overlay
  | "map"       // add a declarative map layer
  | "beacon"    // schedule a beacon  (GATED: also needs the TX gate)
  | "network"   // make an outbound request  (GATED)
  | "tx"        // transmit a frame  (GATED: also needs the H5 TX gate)
  | "geo";      // read device geolocation  (GATED)

export const ALL_CAPABILITIES: Capability[] = [
  "command", "monitor", "event", "decoder", "panel", "map", "beacon", "network", "tx", "geo",
];

/** Capabilities that require an explicit user grant and (tx/beacon) the runtime TX gate. */
export const GATED_CAPABILITIES: Capability[] = ["beacon", "network", "tx", "geo"];

export const isCapability = (x: unknown): x is Capability => typeof x === "string" && (ALL_CAPABILITIES as string[]).includes(x);
export const isGated = (c: Capability): boolean => GATED_CAPABILITIES.includes(c);
