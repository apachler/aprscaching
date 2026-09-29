// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-check
// Austria — Rufzeichenliste österreichischer Amateurfunkstellen, published by the Fernmeldebehörde
// under § 150 TKG 2021 as a PDF linked from the amateur radio service page.
//
// Each station is one table row: callsign, name, location, address, licence class. Holders who opted out
// of publication appear with `*-*-*` in place of their details but keep their callsign, so the list
// covers every Austrian station. The parser reads the text extraction (`pdftotext`) and keeps the
// callsign that starts a line; names and addresses are never read into a row.
import { REGISTER_CALL } from "./common.mjs";

const LINE_CALL = /^[ \t]*(OE[0-9][A-Z0-9]{1,8})(?=[ \t]|$)/;

export default {
  id: "at",
  name: "Fernmeldebehörde Rufzeichenliste (Austria)",
  country: "AT",
  page: "https://www.fb.gv.at/Funk/amateurfunkdienst.html",
  pdfLink: /href="([^"]*Rufzeichenliste[^"]*\.pdf)"/i,
  file: "rufzeichenliste_at.pdf",
  text: true,
  /** @param {AsyncIterable<string>} lines */
  async *parseText(lines) {
    for await (const line of lines) {
      const callsign = LINE_CALL.exec(line)?.[1];
      if (callsign && REGISTER_CALL.test(callsign))
        yield /** @type {import("./common.mjs").LicenceRow} */ ({ callsign, status: "licensed", expiresAt: null });
    }
  },
};
