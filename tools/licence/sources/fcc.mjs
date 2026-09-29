// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-check
// USA — FCC Universal Licensing System, amateur licences (weekly full file l_amat.zip).
//
// HD.dat holds one `|`-delimited "application/license header" record per licence: field 1 is the record
// type `HD`, field 5 the call sign, field 6 the licence status (A active, C cancelled, E expired,
// T terminated), field 7 the radio service (HA amateur, HV vanity) and field 9 the expiry date,
// MM/DD/YYYY. Later fields carry the licensee's name; they are never read. A call can appear on several
// records (an old cancelled grant and a current one); the import keeps the best, a current one first.
import { endOfDayUtc, byExpiry, REGISTER_CALL } from "./common.mjs";
import { memberLines } from "../zip.mjs";

/** @param {string} s */
const usDate = (s) => {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(s);
  return m ? endOfDayUtc(Number(m[3]), Number(m[1]), Number(m[2])) : null;
};

/** One HD record → a row, or null for anything that is not an amateur licence header. */
export function parseHd(/** @type {string} */ line) {
  const f = line.split("|");
  if (f[0] !== "HD") return null;
  const callsign = (f[4] ?? "").trim().toUpperCase();
  if (!REGISTER_CALL.test(callsign)) return null;
  const service = f[6];
  if (service !== "HA" && service !== "HV") return null;
  const expiresAt = usDate(f[8] ?? "");
  const status = f[5] === "A" ? byExpiry(expiresAt) : "expired";
  return /** @type {import("./common.mjs").LicenceRow} */ ({ callsign, status, expiresAt });
}

export default {
  id: "fcc",
  name: "FCC ULS (amateur)",
  country: "US",
  url: "https://data.fcc.gov/download/pub/uls/complete/l_amat.zip",
  file: "l_amat.zip",
  /** @param {string} file */
  async *parse(file) {
    for await (const line of memberLines(file, /^HD\.dat$/i)) {
      const row = parseHd(line);
      if (row) yield row;
    }
  },
};
