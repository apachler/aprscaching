// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-check
// The licence registers the import tool can read, one module per source. Every module exports an `id`,
// a display `name`, a `country`, where to download it (`url`, or a `page` + `pdfLink` to find the
// current edition) and a parser: `parse(file)` for an archive, or `parseText(lines)` for a PDF read
// through its text extraction. A parser yields rows of callsign, status and expiry only.
import fcc from "./fcc.mjs";
import ised from "./ised.mjs";
import acma from "./acma.mjs";
import at from "./at.mjs";
import de from "./de.mjs";

/** @type {Record<string, any>} */
export const SOURCES = { fcc, ised, acma, at, de };
