// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-check
// Germany — Bundesnetzagentur Rufzeichenliste (the published list of assigned amateur callsigns and
// their holders, AFuG § 6 / AFuV § 15), a PDF. An official work under § 5 UrhG.
//
// Every entry opens `CALL, CLASS, ` (class A, E or N) followed by the holder and, where published, an
// address; the list is typeset in columns, so one extracted line can carry several entries. The parser
// takes each `CALL, CLASS, ` opening and nothing after it. Holders may object to publication, so a call
// missing from this list proves nothing.
import { REGISTER_CALL } from "./common.mjs";

const ENTRY = /(?<![A-Z0-9])(D[A-R][0-9]{1,4}[A-Z0-9]{1,8}), [A-Z]{1,2}, /g;

export default {
  id: "de",
  name: "Bundesnetzagentur Rufzeichenliste (Germany)",
  country: "DE",
  url: "https://data.bundesnetzagentur.de/Bundesnetzagentur/SharedDocs/Downloads/DE/Sachgebiete/Telekommunikation/Unternehmen_Institutionen/Frequenzen/Amateurfunk/Rufzeichenliste/rufzeichenliste_afu.pdf",
  file: "rufzeichenliste_de.pdf",
  text: true,
  /** @param {AsyncIterable<string>} lines */
  async *parseText(lines) {
    for await (const line of lines)
      for (const m of line.matchAll(ENTRY)) {
        const callsign = m[1] ?? "";
        if (REGISTER_CALL.test(callsign))
          yield /** @type {import("./common.mjs").LicenceRow} */ ({ callsign, status: "licensed", expiresAt: null });
      }
  },
};
