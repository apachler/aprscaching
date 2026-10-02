// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Stands in for elkjs in the web app's bundle. Mermaid draws with ELK only when a diagram asks for
 * `layout: elk`; the manual's diagrams use the default layout, and ELK's licence (EPL-2.0, with no GPL
 * secondary licence) keeps it out of this AGPL bundle. A diagram that asks for it keeps its source.
 */
export default class NoElk {
  constructor() {
    throw new Error("the ELK layout is not part of this build; use Mermaid's default layout");
  }
}
