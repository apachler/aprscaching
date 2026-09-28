// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * link.ts — the frame-link seam for the connected-mode stack. The NET/ROM node, the session
 * server (NODE/BBS answering inbound connects), and the FBB forwarder all speak raw AX.25 frames;
 * WHICH pipe carries them is an operator choice: a KISS TNC on real RF, or an AXUDP port on the
 * Internet leg of a bridge. Both `KissTnc` and `AxudpPort` satisfy this shape structurally — the
 * services depend on the seam, never the transport, so an interop peer (BPQ, FBB, TNN) reachable
 * only over AXUDP exercises the exact same code as an RF partner.
 */
import type { Ax25Frame } from "@aprscaching/ax25";
import type { ParsedFrame } from "@aprscaching/aprs";
import type { Packet } from "@aprscaching/shared";

export interface FrameLink {
  /** Transmit one AX.25 frame (best-effort; false when the pipe is down). */
  sendFrame(f: Ax25Frame): boolean;
  /** Subscribe to every inbound raw frame (undecoded bytes). */
  onRaw(cb: (b: Uint8Array) => void): void;
  /** Remove a raw subscription (a finished forwarding session must not leak its demux). */
  offRaw?(cb: (b: Uint8Array) => void): void;
}

/** `WIDEn-N` / `TRACEn-N` (an absent SSID is N = 0). */
const FLOOD_HOP = /^(?:WIDE|TRACE)([1-7])(?:-(\d{1,2}))?$/i;

/**
 * Whether a path hop shows the frame was relayed: the has-been-repeated bit (`*`) is set, or a flood /
 * trace digipeater decremented a `WIDEn-N` / `TRACEn-N` hop (N < n) without marking it — an untraced
 * digipeater consumes a hop that way. An untouched hop (`WIDE1-1`, `WIDE2-2`) is not a relay.
 */
function hopUsed(hop: string): boolean {
  if (hop.endsWith("*")) return true;
  const m = FLOOD_HOP.exec(hop.trim());
  return !!m && Number(m[2] ?? 0) < Number(m[1]);
}

/**
 * The receiving-site call to stamp on a frame one of this box's own TNCs heard (KISS, AGWPE, WA8DED
 * host mode), or undefined. Only a frame heard **directly** — no hop in its path shows a digipeater
 * relayed it (see {@link hopUsed}) — is stamped: a digipeated frame proves the originator was near the
 * digipeater, not near this receiver. The rule is conservative: a frame whose originator set a first
 * hop such as `WIDE2-1` is indistinguishable from a decremented `WIDE2-2` and names no site. The stamp only
 * names the site; the gateway attests it (and lifts the frame toward Tier A) solely when the call is in
 * FIRST_PARTY_SITES, and its independence rule keeps an operator's own receiver from corroborating the
 * operator's own finds. No site call configured (`RF_SITE_CALL`, default `IGATE_CALL`) → no stamp.
 */
export function directSiteCall(path: string[], siteCall: string | undefined): string | undefined {
  if (!siteCall?.trim()) return undefined;
  // Digipeaters consume hops in order, so with no `*` anywhere only the first hop can have been
  // decremented; the hops after it are exactly as the originator set them (`WIDE1-1,WIDE2-1` is the
  // standard mobile path, not a relay).
  const relayed = path.some((h) => h.endsWith("*")) || (path.length > 0 && hopUsed(path[0]!));
  return relayed ? undefined : siteCall.trim().toUpperCase();
}

/** The ingest packet for a frame a local TNC heard on the air, stamped with the site when heard directly. */
export function tncPacket(f: ParsedFrame, port: string, siteCall: string | undefined, ts: number): Packet {
  const site = directSiteCall(f.path, siteCall);
  return {
    src: f.src,
    dst: f.dst,
    path: f.path,
    payload: f.payload,
    kind: "other",
    heardVia: "rf",
    ...(site ? { igateCall: site } : {}),
    port,
    ts,
    raw: f.raw,
  };
}
