// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The landing page as static HTML, rendered at build time by vite-prerender.ts. Never part of the app's bundle:
 * the app renders the same Landing itself and takes over from this copy.
 */
import { renderToString } from "react-dom/server";
import { Landing } from "./Landing.js";

export function render(): string {
  return renderToString(<Landing onSignIn={() => {}} onExplore={() => {}} />);
}
