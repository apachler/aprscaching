/**
 * netrom-switch.ts — the NET/ROM node's L3 switch role (docs/29 F2): decide what to do with an inbound
 * network-layer packet. A real node doesn't just originate/terminate circuits — it *transits* other
 * stations' NET/ROM traffic toward its destination (the "switch"). Pure decision core: given a decoded
 * `NrPacket`, our own call, and the learned routing table, return whether to deliver it locally, forward
 * it to a neighbour (TTL-decremented), or drop it (TTL expired / no route). The ingest re-frames a
 * `forward` decision to KISS (that TX is the radio leg); this routing decision is fully unit-tested.
 */
import type { NetromNode } from "./netrom-node.js";
import { addrStr, sameAddr, type Ax25Address } from "@aprsweb/ax25";
import type { NrPacket } from "./netrom-wire.js";

export type SwitchDecision =
  | { action: "local" }                                             // dest is us → hand to the circuit layer
  | { action: "forward"; neighbor: Ax25Address; packet: NrPacket }  // transit → re-send to this neighbour (TTL-1)
  | { action: "drop"; reason: "ttl" | "no-route" | "loop" };

/**
 * Route one inbound NET/ROM network packet. Local delivery when addressed to us; otherwise transit-forward
 * toward its destination via the best learned route (dropping on TTL expiry, no route, or a self-loop).
 */
export function routeNetrom(pkt: NrPacket, node: NetromNode, me: Ax25Address): SwitchDecision {
  if (sameAddr(pkt.net.dest, me)) return { action: "local" };
  const ttl = pkt.net.ttl - 1;
  if (ttl <= 0) return { action: "drop", reason: "ttl" };
  const route = node.best(addrStr(pkt.net.dest));
  if (!route) return { action: "drop", reason: "no-route" };
  if (sameAddr(route.neighbor, me) || sameAddr(route.neighbor, pkt.net.origin)) return { action: "drop", reason: "loop" };
  return { action: "forward", neighbor: route.neighbor, packet: { ...pkt, net: { ...pkt.net, ttl } } };
}
