// SPDX-License-Identifier: MIT
/**
 * fedbeacon.ts — the beacon tier: ONE signed fedwire frame in ONE unconnected AX.25 UI datagram, for
 * links where even a BBS session is a luxury (HF, 300 Bd). The payload is binary (KISS/AX.25 pass
 * 8-bit clean): a magic + version header followed by the frame verbatim. There is no batch envelope
 * and no BID — a beacon dedups by its record's global id through the idempotent apply, exactly like
 * every other carrier. Fit is bounded to a single frame: typical HF packet MTU minus headers.
 */

/** Datagram header: magic + wire version ("ACSB1"). */
export const FED_BEACON_MAGIC = Uint8Array.from([0x41, 0x43, 0x53, 0x42, 0x31]);

/**
 * The largest beacon payload a single AX.25 UI frame carries comfortably: PACLEN 256 minus the
 * beacon header, with margin for digipeater path variance. A record that doesn't fit doesn't beacon
 * — it belongs on the compact tier instead.
 */
export const MAX_BEACON_BYTES = 251;

/** Wrap one signed fedwire frame as a beacon datagram payload. Throws when the frame doesn't fit. */
export function encodeFedBeacon(frame: Uint8Array): Uint8Array<ArrayBuffer> {
  if (!frame.length) throw new Error("fedbeacon: empty frame");
  if (frame.length > MAX_BEACON_BYTES)
    throw new Error(
      `fedbeacon: frame is ${frame.length} bytes — over the ${MAX_BEACON_BYTES}-byte single-datagram fit`,
    );
  const out = new Uint8Array(FED_BEACON_MAGIC.length + frame.length);
  out.set(FED_BEACON_MAGIC, 0);
  out.set(frame, FED_BEACON_MAGIC.length);
  return out;
}

/** Unwrap a heard datagram payload back to its frame bytes, or null when it is not a beacon. */
export function decodeFedBeacon(payload: Uint8Array): Uint8Array | null {
  if (payload.length <= FED_BEACON_MAGIC.length) return null;
  for (let i = 0; i < FED_BEACON_MAGIC.length; i++) if (payload[i] !== FED_BEACON_MAGIC[i]) return null;
  const frame = payload.subarray(FED_BEACON_MAGIC.length);
  if (frame.length > MAX_BEACON_BYTES) return null;
  return frame;
}
