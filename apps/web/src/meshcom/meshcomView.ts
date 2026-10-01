// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The MeshCom map layer's wording and shapes, kept free of the DOM so they are testable: how a node was
 * heard, its signal and battery in plain words, the link lines as GeoJSON, and the MeshMap link. Everything
 * here is what the operator's own node(s) observed — never the whole network — and the wording says so.
 */
import { meshcomHardwareName } from "@aprscaching/aprs";
import type { MeshcomLink, MeshcomNode } from "../api.js";

/** The one sentence the links legend always carries. */
export const LINKS_VIEWPOINT = "Links as heard by your MeshCom node(s), not the whole network.";

/** Attribution for the official network-wide map. */
export const MESHMAP_ATTRIBUTION = "MeshMap by ICSSW / ÖVSV";
const MESHMAP = "https://meshmap.oevsv.at";

/** MeshMap's page for a node (its `/node/<call>` route), or its front page. */
export function meshmapUrl(callsign?: string): string {
  return callsign ? `${MESHMAP}/node/${encodeURIComponent(callsign)}` : `${MESHMAP}/`;
}

/** How the node was last heard, in words. */
export function viaText(n: Pick<MeshcomNode, "via" | "receiver">): string {
  const by = n.receiver ? ` by ${n.receiver}` : "";
  switch (n.via) {
    case "direct":
      return `Heard directly${by}`;
    case "relayed":
      return `Heard${by} through a relay`;
    case "server":
      return "Via the MeshCom server, not heard on the air here";
    case "node":
      return "Your MeshCom node";
    default:
      return "Heard over MeshCom";
  }
}

const QUALITY_TEXT = { strong: "strong", usable: "usable", weak: "weak" } as const;
const BATT_TEXT = { high: "high", medium: "medium", low: "low" } as const;

/** The signal of the last LoRa hearing: the exact figures when the viewer may see them, else the bucket. */
export function signalText(n: Pick<MeshcomNode, "quality" | "rssi" | "snr">): string | null {
  const exact = [n.rssi != null ? `RSSI ${n.rssi} dBm` : null, n.snr != null ? `SNR ${n.snr} dB` : null]
    .filter(Boolean)
    .join(", ");
  if (!n.quality && !exact) return null;
  const word = n.quality ? QUALITY_TEXT[n.quality] : null;
  return [word && `${word[0]!.toUpperCase()}${word.slice(1)} signal`, exact && `(${exact})`].filter(Boolean).join(" ");
}

export function batteryText(n: Pick<MeshcomNode, "batt" | "battLevel">): string | null {
  if (n.batt != null) return `Battery ${n.batt} %`;
  return n.battLevel ? `Battery ${BATT_TEXT[n.battLevel]}` : null;
}

export function deviceText(n: Pick<MeshcomNode, "hwId" | "firmware">): string | null {
  const dev = n.hwId != null ? meshcomHardwareName(n.hwId) : null;
  const fw = n.firmware ? `firmware ${n.firmware}` : null;
  return [dev, fw].filter(Boolean).join(", ") || null;
}

/** Explains a via list: the sender's plan, not the path the message took. */
export const SENT_VIA_HINT = "The sender limited forwarding to these nodes.";

/** The relays the node's latest message named, in words; null when it named none. */
export function sentViaText(n: Pick<MeshcomNode, "sentVia">): string | null {
  return n.sentVia?.length ? `Sent via relays ${n.sentVia.join(", ")}` : null;
}

/** The marker's classes: a MeshCom ring on the station pin, dashed for a node heard only via the server. */
export function nodePinClass(n: Pick<MeshcomNode, "via">): string {
  return `station-pin meshcom${n.via === "server" ? " via-server" : ""}`;
}

export function nodeTitle(n: MeshcomNode): string {
  return [n.callsign, "MeshCom", viaText(n)].join(" · ");
}

/** Lines fade over this window: a link last seen at its start is barely visible. */
export const LINK_WINDOW_S = 24 * 3600;

type LineFeature = {
  type: "Feature";
  geometry: { type: "LineString"; coordinates: [number, number][] };
  properties: { kind: string; width: number; opacity: number; label: string };
};

const WIDTH = { strong: 4, usable: 2.5, weak: 1.5 } as const;

/**
 * The link lines: only links whose both ends are placed; direct links and relay legs are told apart by the
 * layer (solid or dashed), strength by the width, age by the opacity — colour carries nothing on its own.
 */
export function linkFeatures(
  links: MeshcomLink[],
  now: number,
  windowS = LINK_WINDOW_S,
): { type: "FeatureCollection"; features: LineFeature[] } {
  const features: LineFeature[] = [];
  for (const l of links) {
    const ends = [l.fromLat, l.fromLon, l.toLat, l.toLon];
    if (!ends.every((v) => typeof v === "number" && Number.isFinite(v))) continue;
    const age = Math.max(0, now - l.lastSeen);
    if (age > windowS) continue;
    const opacity = Math.round((1 - 0.75 * (age / windowS)) * 100) / 100;
    const kind = l.kind === "direct" ? "direct" : "relay";
    const signal = signalText({ quality: l.quality ?? null, rssi: l.rssi ?? null, snr: l.snr ?? null });
    features.push({
      type: "Feature",
      geometry: {
        type: "LineString",
        coordinates: [
          [l.fromLon, l.fromLat],
          [l.toLon, l.toLat],
        ],
      },
      properties: {
        kind,
        width: l.quality ? WIDTH[l.quality] : 1.5,
        opacity,
        label: `${l.from} → ${l.to}: ${kind === "direct" ? "direct" : "relay leg"}${signal ? `, ${signal.toLowerCase()}` : ""}${l.receiver ? `, as heard by ${l.receiver}` : ""}`,
      },
    });
  }
  return { type: "FeatureCollection", features };
}
