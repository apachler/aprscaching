// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * fedcompress.ts (ingest) — the deflate codec behind the negotiated `deflateDict1` link capability.
 * It lives here because compact-tier RF links always terminate at the operator's ingest box, and
 * Node's zlib is the runtime with preset-dictionary support. The dictionary bytes are the shared
 * wire contract (packages/shared); this module is only the codec around them.
 */
import { deflateSync, inflateSync } from "node:zlib";
import { FED_DEFLATE_DICT } from "@aprscaching/shared";

/** Bound decompressed output so a hostile tiny payload can't balloon into memory (zip-bomb guard). */
const MAX_INFLATED_BYTES = 4 * 1024 * 1024;

/**
 * Compress link payload bytes under the negotiated preset dictionary. The zlib container (not raw
 * deflate) is deliberate: its adler32 makes corrupt input FAIL decode instead of silently yielding
 * wrong bytes — six bytes of overhead for a hard error surface, before the signature check even runs.
 */
export function compressDict1(payload: Uint8Array): Uint8Array {
  return new Uint8Array(deflateSync(payload, { dictionary: FED_DEFLATE_DICT, level: 9 }));
}

/** Decompress a `deflateDict1` payload; null on corrupt input or an over-bound expansion. */
export function decompressDict1(compressed: Uint8Array): Uint8Array | null {
  try {
    const out = inflateSync(compressed, { dictionary: FED_DEFLATE_DICT, maxOutputLength: MAX_INFLATED_BYTES });
    return new Uint8Array(out);
  } catch {
    return null;
  }
}
