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

/**
 * The receiving-site call to stamp on a frame one of this box's own TNCs heard (KISS, AGWPE, WA8DED
 * host mode), or undefined. Only a frame heard **directly** — no digipeater in its path has set the
 * has-been-repeated bit (`*`) — is stamped: a digipeated frame proves the originator was near the
 * digipeater, not near this receiver. An unused `WIDE` hop is not a relay. The stamp only names the site;
 * the gateway attests it (and lifts the frame toward Tier A) solely when the call is in
 * FIRST_PARTY_SITES, and its independence rule keeps an operator's own receiver from corroborating the
 * operator's own finds. No site call configured (`RF_SITE_CALL`, default `IGATE_CALL`) → no stamp.
 */
export function directSiteCall(path: string[], siteCall: string | undefined): string | undefined {
  if (!siteCall?.trim()) return undefined;
  return path.some((h) => h.endsWith("*")) ? undefined : siteCall.trim().toUpperCase();
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
