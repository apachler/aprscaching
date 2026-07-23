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

export interface FrameLink {
  /** Transmit one AX.25 frame (best-effort; false when the pipe is down). */
  sendFrame(f: Ax25Frame): boolean;
  /** Subscribe to every inbound raw frame (undecoded bytes). */
  onRaw(cb: (b: Uint8Array) => void): void;
  /** Remove a raw subscription (a finished forwarding session must not leak its demux). */
  offRaw?(cb: (b: Uint8Array) => void): void;
}
