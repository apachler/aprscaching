// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The label and badge colour of each kind of alert in the alert list. A watched station's alerts (heard, near a
 * cache) sit beside notices about the account itself: the sysop removing or restoring something it wrote, a
 * suspension and its lifting, a callsign released. Each kind reads as what it is; a kind this app does not know
 * shows as a plain notice, never as another kind.
 */
export interface AlertKindView {
  label: string;
  /** The Badge kind (styles/components/data.css), or undefined for the neutral chip. */
  badge?: string;
}

const KINDS: Record<string, AlertKindView> = {
  heard: { label: "heard", badge: "tierC" },
  near_cache: { label: "near cache", badge: "tierA" },
  cache_found: { label: "found your cache", badge: "tierB" },
  corroborated: { label: "you corroborated", badge: "tierA" },
  removed: { label: "Removed by the sysop", badge: "warn" },
  restored: { label: "Restored by the sysop" },
  suspended: { label: "Account suspended", badge: "warn" },
  unsuspended: { label: "Suspension lifted" },
  call_released: { label: "Callsign released", badge: "warn" },
};

export function alertKindView(kind: string): AlertKindView {
  return KINDS[kind] ?? { label: "Notice" };
}
