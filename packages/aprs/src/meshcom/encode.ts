// SPDX-License-Identifier: MIT
/**
 * Client → node text datagram for LoRa transmission over ExtUDP.
 *
 * Limits follow the firmware's inbound parser (`getExtern()` in `src/extudp_functions.cpp`): `dst` is 1–9
 * bytes and `msg` 1–150 bytes, both measured with `strlen`, so the text limit is UTF-8 **bytes** — an
 * umlaut costs two, an emoji four. A NUL rejects the whole datagram there, so control characters are
 * collapsed here before measuring.
 *
 * Only direct messages to a callsign are encodable. Group and `*` traffic reaches every station on a
 * shared, slow channel, so software never originates it.
 */
import { classifyMeshcomDst, collapseControls } from "./normalize.js";

/** The firmware's maximum message length, in UTF-8 bytes. */
export const MESHCOM_MAX_TEXT_BYTES = 150;

export type MeshcomEncodeReason = "bad-dst" | "dst-not-allowed" | "empty-text" | "text-too-long";

export type MeshcomEncodeResult =
  { ok: true; datagram: string; dst: string; bytes: number } | { ok: false; reason: MeshcomEncodeReason };

const utf8 = new TextEncoder();

export function encodeMeshcomText(dst: string, text: string): MeshcomEncodeResult {
  const d = classifyMeshcomDst(dst);
  if (!d) return { ok: false, reason: "bad-dst" };
  if (d.kind !== "call") return { ok: false, reason: "dst-not-allowed" };
  const msg = collapseControls(text);
  if (!msg) return { ok: false, reason: "empty-text" };
  const bytes = utf8.encode(msg).byteLength;
  if (bytes > MESHCOM_MAX_TEXT_BYTES) return { ok: false, reason: "text-too-long" };
  return { ok: true, datagram: JSON.stringify({ type: "msg", dst: d.dst, msg }), dst: d.dst, bytes };
}
