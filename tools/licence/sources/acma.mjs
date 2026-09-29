// SPDX-License-Identifier: AGPL-3.0-or-later
// @ts-check
// Australia — ACMA Register of Radiocommunications Licences (spectra_rrl.zip).
//
// licence.csv lists every apparatus licence; SV_ID 6 is the Amateur service. device_details.csv links a
// LICENCE_NO to its CALL_SIGN. Individual operators hold the amateur class licence, which the register
// does not list, so this source covers amateur repeaters and beacons only. Only LICENCE_NO, SV_ID,
// DATE_OF_EXPIRY, STATUS_TEXT and CALL_SIGN are read; client.csv (licensee details) is never opened.
import { endOfDayUtc, byExpiry, csvRecords, REGISTER_CALL } from "./common.mjs";
import { memberLines } from "../zip.mjs";

const AMATEUR_SERVICE = "6";
const CURRENT = new Set(["Granted", "Granted (Under modification)"]);
const ENDED = new Set(["Expired", "Revoked", "Canceled", "Surrendered", "Surrendred", "Suspended"]);

/** @param {string} s */
const isoDate = (s) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  return m ? endOfDayUtc(Number(m[1]), Number(m[2]), Number(m[3])) : null;
};

/**
 * Records of a CSV member as objects keyed by the header row.
 * @param {string} file @param {RegExp} member @returns {AsyncIterable<Record<string, string>>}
 */
async function* rowsOf(file, member) {
  /** @type {string[] | null} */
  let head = null;
  for await (const rec of csvRecords(memberLines(file, member))) {
    if (!head) {
      head = rec.map((h) => h.trim());
      continue;
    }
    /** @type {Record<string, string>} */
    const o = {};
    head.forEach((h, i) => (o[h] = rec[i] ?? ""));
    yield o;
  }
}

export default {
  id: "acma",
  name: "ACMA Register of Radiocommunications Licences (amateur repeaters and beacons)",
  country: "AU",
  url: "https://web.acma.gov.au/rrl-updates/spectra_rrl.zip",
  file: "spectra_rrl.zip",
  /** @param {string} file */
  async *parse(file) {
    /** @type {Map<string, { status: "licensed" | "expired", expiresAt: number | null }>} */
    const licences = new Map();
    for await (const l of rowsOf(file, /^licence\.csv$/i)) {
      if (l.SV_ID !== AMATEUR_SERVICE) continue;
      const expiresAt = isoDate(l.DATE_OF_EXPIRY ?? "");
      const text = (l.STATUS_TEXT ?? "").trim();
      if (CURRENT.has(text)) licences.set(l.LICENCE_NO ?? "", { status: byExpiry(expiresAt), expiresAt });
      else if (ENDED.has(text)) licences.set(l.LICENCE_NO ?? "", { status: "expired", expiresAt });
    }
    for await (const d of rowsOf(file, /^device_details\.csv$/i)) {
      const lic = licences.get(d.LICENCE_NO ?? "");
      const callsign = (d.CALL_SIGN ?? "").trim().toUpperCase();
      if (lic && REGISTER_CALL.test(callsign))
        yield /** @type {import("./common.mjs").LicenceRow} */ ({ callsign, ...lic });
    }
  },
};
