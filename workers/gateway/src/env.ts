import type { SqlDatabase, ObjectStore, RoomNamespace } from "./runtime.js";

/** Bindings the gateway needs, in runtime-neutral terms (see runtime.ts). */
export interface Env {
  DB: SqlDatabase;
  TILES: ObjectStore;
  ROOMS: RoomNamespace;
  INGEST_SECRET: string;
}
