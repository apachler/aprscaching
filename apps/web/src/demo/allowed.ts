// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Where the design benches (`?demo=app|ui|packet|bbs`) and the demo tool installs run: a development build or a
 * driven browser (the visual and accessibility harness). A bench signs the page in as a fixture account whose
 * callsign is verified and writes to the visitor's own storage, so a production page a person opens never takes
 * one; the public tours (`/tour/…`) are the isolated demo for visitors.
 */
export const demoAllowed = (): boolean => import.meta.env.DEV || navigator.webdriver === true;
