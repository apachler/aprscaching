// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The words for a decoded field. A decoder tool lists a packet's fields in a table headed "Field" under their data
 * names (`speedKn`, `altitudeM`); the host shows them as a person reads them ("Speed (kn)", "Altitude (m)"). A name
 * that is not an identifier, such as a tool's own prose, stays as the tool wrote it.
 */
const KNOWN: Record<string, string> = {
  lat: "Latitude",
  lon: "Longitude",
  speedKn: "Speed (kn)",
  altitudeM: "Altitude (m)",
  rangeKm: "Range (km)",
  course: "Course (°)",
  messageType: "Message type",
  heardVia: "Heard via",
  igateCall: "IGate",
  phg: "PHG",
  dst: "Destination",
  src: "Source",
};
/** A unit at the end of a data name, as it reads after the words. */
const UNITS: [RegExp, string][] = [
  [/Kmh$/, "km/h"],
  [/Kn$/, "kn"],
  [/Km$/, "km"],
  [/Mm$/, "mm"],
  [/Hpa$/, "hPa"],
  [/Pct$/, "%"],
  [/M$/, "m"],
  [/C$/, "°C"],
];

export function fieldLabel(name: string): string {
  if (KNOWN[name]) return KNOWN[name];
  if (!/^[a-z][a-zA-Z0-9]*$/.test(name)) return name;
  let base = name;
  let unit = "";
  for (const [re, u] of UNITS)
    if (re.test(base) && base.replace(re, "").length > 0) {
      base = base.replace(re, "");
      unit = u;
      break;
    }
  const words = base
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([a-zA-Z])(\d)/g, "$1 $2")
    .toLowerCase();
  const text = words.charAt(0).toUpperCase() + words.slice(1);
  return unit ? `${text} (${unit})` : text;
}
