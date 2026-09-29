// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-check
// Canada — ISED amateur call sign list (amateur_delim.zip → amateur_delim.txt).
//
// One `;`-separated record per assigned call sign after a header line: callsign first, then given names,
// surname, address, qualifications and club details. Only the first field is read. Canadian amateur
// certificates carry no expiry, so every listed call is licensed with no expiry date.
import { REGISTER_CALL } from "./common.mjs";
import { memberLines } from "../zip.mjs";

export default {
  id: "ised",
  name: "ISED Canada amateur call sign list",
  country: "CA",
  url: "https://apc-cap.ic.gc.ca/datafiles/amateur_delim.zip",
  file: "amateur_delim.zip",
  /** @param {string} file */
  async *parse(file) {
    for await (const line of memberLines(file, /^amateur_delim\.txt$/i)) {
      const callsign = (line.split(";", 1)[0] ?? "").trim().toUpperCase();
      if (REGISTER_CALL.test(callsign))
        yield /** @type {import("./common.mjs").LicenceRow} */ ({ callsign, status: "licensed", expiresAt: null });
    }
  },
};
