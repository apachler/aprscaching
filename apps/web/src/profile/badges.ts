// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The badges the gateway awards (workers/gateway/src/community.ts), by id: the name a profile shows and the
 * one line that says how it was earned. An id this table does not know shows as itself, so a newer
 * gateway's badge still appears.
 */
export interface BadgeInfo {
  name: string;
  how: string;
}

const BADGES: Record<string, BadgeInfo> = {
  "first-find": { name: "First find", how: "Logged a first verified find." },
  "finder-10": { name: "10 finds", how: "Ten verified finds." },
  "finder-50": { name: "50 finds", how: "Fifty verified finds." },
  "finder-100": { name: "100 finds", how: "A hundred verified finds." },
  "finder-500": { name: "500 finds", how: "Five hundred verified finds." },
  "rf-verified": { name: "Radio-verified", how: "A find heard on the air: Tier A." },
  summiteer: { name: "Summiteer", how: "Found a SOTA summit." },
  "park-hunter": { name: "Park hunter", how: "Found a POTA park." },
  "rover-hunter": { name: "Rover hunter", how: "Met a living cache on the move." },
  "flora-fauna": { name: "Flora & fauna", how: "Found a WWFF reserve." },
  "castle-hunter": { name: "Castle hunter", how: "Found a castle." },
  "bunker-hunter": { name: "Bunker hunter", how: "Found a bunker." },
  hider: { name: "Hider", how: "Hid a first cache." },
  "cache-architect": { name: "Cache architect", how: "Hid five caches." },
  "cache-master": { name: "Cache master", how: "Hid twenty caches." },
};

export function badgeInfo(id: string): BadgeInfo {
  return BADGES[id] ?? { name: id, how: "" };
}
