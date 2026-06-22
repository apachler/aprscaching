export interface Env {
  DB: D1Database;
  TILES: R2Bucket;
  ROOMS: DurableObjectNamespace;
  INGEST_SECRET: string;
}
