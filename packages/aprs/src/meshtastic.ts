/**
 * meshtastic.ts — parse a Meshtastic MQTT JSON envelope (the gateway's "JSON output" mode) into a
 * position fix. Pure; the connector (apps/ingest) handles the MQTT transport. Protobuf/BLE/serial
 * paths are deeper work tracked separately.
 *
 * Envelope shape (position): { from, sender:"!hex", type:"position",
 *   payload:{ latitude_i, longitude_i, altitude } }
 */
export interface MeshFix { node: string; lat: number; lon: number; altitudeM?: number; longName?: string }

export function parseMeshtasticJson(input: string | Record<string, unknown>): MeshFix | null {
  let o: any;
  try { o = typeof input === "string" ? JSON.parse(input) : input; } catch { return null; }
  if (!o || typeof o !== "object") return null;
  if (o.type && o.type !== "position") return null;
  const p = o.payload ?? o;
  const lat = typeof p.latitude_i === "number" ? p.latitude_i / 1e7 : Number(p.latitude);
  const lon = typeof p.longitude_i === "number" ? p.longitude_i / 1e7 : Number(p.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || (lat === 0 && lon === 0)) return null;
  const node = String(o.sender ?? o.from ?? "MESH");
  const fix: MeshFix = { node, lat, lon };
  const alt = Number(p.altitude);
  if (Number.isFinite(alt) && alt !== 0) fix.altitudeM = Math.round(alt);
  if (typeof o.longname === "string") fix.longName = o.longname;
  return fix;
}
