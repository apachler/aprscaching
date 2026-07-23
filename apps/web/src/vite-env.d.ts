// SPDX-License-Identifier: AGPL-3.0-or-later
/// <reference types="vite/client" />

// The manual, bundled at build time by vite-docs.ts.
declare module "virtual:docs" {
  export interface DocPage {
    slug: string;
    title: string;
    section: string;
    order: number;
    body: string;
  }
  export const DOC_PAGES: DocPage[];
}
