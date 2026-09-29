// SPDX-License-Identifier: AGPL-3.0-or-later
/** The current time in whole unix seconds — the unit every gateway table and signed record uses. */
export const nowS = (): number => Math.floor(Date.now() / 1000);
