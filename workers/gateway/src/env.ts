import type { SqlDatabase, ObjectStore, MediaStore, RoomNamespace } from "./runtime.js";

/** Bindings the gateway needs, in runtime-neutral terms (see runtime.ts). */
export interface Env {
  DB: SqlDatabase;
  TILES: ObjectStore;
  MEDIA?: MediaStore;       // audio-cache clue storage (R2 on CF, FS on Node); optional
  ROOMS: RoomNamespace;
  INGEST_SECRET: string;

  // ---- federation (F1) — all optional; absent => feeds served unsigned ----
  INSTANCE?: string;        // canonical instance id/domain, e.g. "oe.aprscaching.org"
  FED_PRIVATE_KEY?: string; // base64(JWK) Ed25519 signing key; if set, records are signed
  FED_PEERS?: string;       // comma-separated peer base URLs, advertised in the descriptor
  FED_DISCOVER?: string;    // if set, auto-add peers advertised by peers (transitive discovery)

  // ---- imports (M3) — OpenCaching OKAPI ----
  OKAPI_BASE?: string;      // e.g. https://www.opencaching.de
  OKAPI_KEY?: string;       // free per-node consumer key (Level-1)

  // ---- BBS store-and-forward — the relay callsign personal mail is delivered from ----
  BBS_CALL?: string;        // e.g. "OE8APR-5"; defaults to "APRSCG"
}
