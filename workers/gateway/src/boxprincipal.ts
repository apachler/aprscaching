// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The box behind a signed request, once route() has verified its signature (boxkeys.ts authenticateBox).
 * Kept apart from boxkeys.ts so the credential checks in auth.ts can read it without importing the
 * enrollment endpoints.
 */

/** A request a box signed and the gateway verified. */
interface BoxPrincipal {
  box: string;
  /** The base call the box was enrolled for, when its code named one. */
  callsign: string | null;
  /** The sysop lets the box run this instance's services (box_keys.services). */
  services: boolean;
}

const principals = new WeakMap<Request, BoxPrincipal>();

export function setBoxPrincipal(req: Request, p: BoxPrincipal): void {
  principals.set(req, p);
}

/** The box that signed this request, or null for any other request. */
export function boxPrincipal(req: Request): BoxPrincipal | null {
  return principals.get(req) ?? null;
}
