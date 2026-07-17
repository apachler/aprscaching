// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * fedbeacon.ts — the gateway binding of the beacon tier. GET serves this instance's presence beacon
 * (a signed `peer` record: instance id + typed endpoints) as a ready-to-transmit datagram payload —
 * the operator's ingest box fetches it and beacons it on its own schedule (TX stays operator-local
 * and gated). POST is the receive side: the ingest box heard a UI datagram and hands the payload to
 * the same trust-gated pipeline every carrier feeds — a beacon from an unknown origin is quarantined
 * and can never introduce a peer.
 */
import type { Env } from "./env.js";
import { json } from "./app.js";
import { requireSysop } from "./admin.js";
import { instanceOf } from "./federation.js";
import { signFedRecord } from "./fedcbor.js";
import { applyFedFrames } from "./federation_sync.js";
import { encodeFedBeacon, decodeFedBeacon, parseEndpoints, MAX_BEACON_BYTES, type FedEndpoint } from "@aprsweb/shared";

const MAX_RX_BYTES = 4096; // a heard datagram is small by nature; refuse anything bulk

function parseJsonArray(s: string | undefined): unknown[] {
  if (!s) return [];
  try {
    const v: unknown = JSON.parse(s);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

/**
 * GET /federation/beacon — the instance's current presence beacon, application/octet-stream. The
 * endpoint set is trimmed from the lowest priority up until the datagram fits the single-frame
 * bound; identity (instance + signing key on the frame) always rides.
 */
export async function handleBeaconEmit(req: Request, env: Env): Promise<Response> {
  const instance = instanceOf(req, env);
  const at = Math.floor(Date.now() / 1000);
  let addresses: FedEndpoint[] = parseEndpoints(parseJsonArray(env.FED_ENDPOINTS));
  for (;;) {
    const frame = await signFedRecord(env, {
      kind: "peer",
      gid: `${instance}:peer:announce`,
      origin: instance,
      v: at,
      at,
      signer: instance,
      body: addresses.length ? { addresses } : {},
    });
    if (!frame) return json({ error: "instance is unsigned — configure FED_PRIVATE_KEY" }, { status: 404 });
    if (frame.length <= MAX_BEACON_BYTES)
      return new Response(encodeFedBeacon(frame), {
        headers: { "content-type": "application/octet-stream" },
      });
    if (!addresses.length)
      return json({ error: `beacon exceeds the ${MAX_BEACON_BYTES}-byte single-datagram fit` }, { status: 507 });
    addresses = addresses.slice(0, -1); // parseEndpoints sorts by priority — the least urgent drops first
  }
}

/** POST /federation/beacon — a heard datagram payload from the operator's ingest box. */
export async function handleBeaconRx(req: Request, env: Env): Promise<Response> {
  const denied = await requireSysop(req, env, { allowIngest: true });
  if (denied) return denied;
  const bytes = new Uint8Array(await req.arrayBuffer());
  if (bytes.length > MAX_RX_BYTES) return json({ error: "payload too large for a datagram" }, { status: 413 });
  const frame = decodeFedBeacon(bytes);
  if (!frame) return json({ federation: false, applied: 0, quarantined: 0, rejected: 0 });
  const r = await applyFedFrames(env, [frame]);
  return json({ federation: true, ...r });
}
