// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import {
  sentViaText,
  SENT_VIA_HINT,
  LINKS_VIEWPOINT,
  MESHMAP_ATTRIBUTION,
  batteryText,
  deviceText,
  linkFeatures,
  meshmapUrl,
  nodePinClass,
  signalText,
  viaText,
} from "../src/meshcom/meshcomView.js";
import type { MeshcomLink } from "../src/api.js";

describe("how a node was heard", () => {
  it("names the receiver and never presents the server as the air", () => {
    expect(viaText({ via: "direct", receiver: "OE8APR-12" })).toBe("Heard directly by OE8APR-12");
    expect(viaText({ via: "relayed", receiver: "OE8APR-12" })).toBe("Heard by OE8APR-12 through a relay");
    expect(viaText({ via: "server", receiver: "OE8APR-12" })).toBe("Via the MeshCom server, not heard on the air here");
    expect(viaText({ via: "node", receiver: "OE8APR-12" })).toBe("Your MeshCom node");
    expect(viaText({ via: "direct", receiver: null })).toBe("Heard directly");
  });
  it("marks a server-relayed node with its own pin class, not by colour alone", () => {
    expect(nodePinClass({ via: "server" })).toBe("station-pin meshcom via-server");
    expect(nodePinClass({ via: "direct" })).toBe("station-pin meshcom");
  });
});

describe("signal, battery and device in words", () => {
  it("gives a visitor the bucket and a member the figures", () => {
    expect(signalText({ quality: "usable", rssi: null, snr: null })).toBe("Usable signal");
    expect(signalText({ quality: "strong", rssi: -95, snr: 7 })).toBe("Strong signal (RSSI -95 dBm, SNR 7 dB)");
    expect(signalText({ quality: null, rssi: null, snr: null })).toBeNull();
    expect(batteryText({ batt: 91, battLevel: "high" })).toBe("Battery 91 %");
    expect(batteryText({ batt: undefined, battLevel: "low" })).toBe("Battery low");
    expect(batteryText({ battLevel: null })).toBeNull();
  });
  it("names the device from its hardware id, and says when it is unknown", () => {
    expect(deviceText({ hwId: 8, firmware: "4.35t" })).toBe("LilyGO T-Deck, firmware 4.35t");
    expect(deviceText({ hwId: 13, firmware: null })).toBe("Unknown device (ID 13)");
    expect(deviceText({ hwId: null, firmware: null })).toBeNull();
  });
});

describe("a node's via list", () => {
  it("names the relays as the sender's limit, never as a route", () => {
    expect(sentViaText({ sentVia: ["OE1KBC-24", "OE1KFR-12"] })).toBe("Sent via relays OE1KBC-24, OE1KFR-12");
    expect(sentViaText({})).toBeNull();
    expect(sentViaText({ sentVia: [] })).toBeNull();
    expect(SENT_VIA_HINT).toMatch(/limited forwarding/);
  });
});

describe("links", () => {
  const now = 1_000_000;
  const link = (over: Partial<MeshcomLink> = {}): MeshcomLink => ({
    from: "OE8XYZ-1",
    to: "OE8APR-12",
    kind: "direct",
    lastSeen: now - 60,
    samples: 3,
    receiver: "OE8APR-12",
    fromLat: 47.1,
    fromLon: 15.5,
    toLat: 47.07,
    toLon: 15.44,
    quality: "strong",
    ...over,
  });

  it("draws a direct link and each relay leg, telling them apart by kind and strength by width", () => {
    const fc = linkFeatures([link(), link({ from: "DL1AAA-1", to: "OE8RLY-2", kind: "relay", quality: null })], now);
    expect(fc.features.map((f) => f.properties.kind)).toEqual(["direct", "relay"]);
    expect(fc.features[0]!.geometry.coordinates).toEqual([
      [15.5, 47.1],
      [15.44, 47.07],
    ]);
    expect(fc.features[0]!.properties.width).toBeGreaterThan(fc.features[1]!.properties.width);
    expect(fc.features[0]!.properties.label).toBe("OE8XYZ-1 → OE8APR-12: direct, strong signal, as heard by OE8APR-12");
  });

  it("skips a link with an unplaced end", () => {
    expect(linkFeatures([link({ toLat: null as unknown as number })], now).features).toHaveLength(0);
  });

  it("fades a link with age and drops it past the window", () => {
    const [fresh, old] = linkFeatures([link({ lastSeen: now }), link({ lastSeen: now - 12 * 3600 })], now).features;
    expect(fresh!.properties.opacity).toBe(1);
    expect(old!.properties.opacity).toBeLessThan(1);
    expect(linkFeatures([link({ lastSeen: now - 25 * 3600 })], now).features).toHaveLength(0);
  });

  it("states the viewpoint and credits MeshMap", () => {
    expect(LINKS_VIEWPOINT).toBe("Links as heard by your MeshCom node(s), not the whole network.");
    expect(MESHMAP_ATTRIBUTION).toBe("MeshMap by ICSSW / ÖVSV");
    expect(meshmapUrl("OE8APR-12")).toBe("https://meshmap.oevsv.at/node/OE8APR-12");
    expect(meshmapUrl()).toBe("https://meshmap.oevsv.at/");
  });
});
