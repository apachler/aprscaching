import { describe, it, expect } from "vitest";
import { cachesToGpx, cachesToKml, findsToAdif, trackToKml, type ExpCache, type ExpFind } from "../src/exports.js";

const cache: ExpCache = { code: "AC-0001", title: "Schlossberg Clock Tower", type: "single", difficulty: 1.5, terrain: 2, lat: 47.0735, lon: 15.4378, ownerCall: "OE8APR" };

describe("read-API exports (docs/11 M3)", () => {
  it("cachesToGpx emits valid GPX waypoints", () => {
    const gpx = cachesToGpx([cache]);
    expect(gpx).toContain('<?xml version="1.0"');
    expect(gpx).toContain('<gpx version="1.1"');
    expect(gpx).toContain('<wpt lat="47.0735" lon="15.4378">');
    expect(gpx).toContain("<name>AC-0001</name>");
    expect(gpx).toContain("<sym>Geocache</sym>");
  });

  it("cachesToKml emits placemarks with lon,lat,0 coordinates", () => {
    const kml = cachesToKml([cache]);
    expect(kml).toContain("<kml xmlns=");
    expect(kml).toContain("<Placemark>");
    expect(kml).toContain("<coordinates>15.4378,47.0735,0</coordinates>");
    expect(kml).toContain("<name>AC-0001</name>");
  });

  it("XML exports escape special characters in titles", () => {
    const tricky: ExpCache = { ...cache, title: "A & B <C>", code: "AC-0009" };
    const gpx = cachesToGpx([tricky]);
    expect(gpx).toContain("A &amp; B &lt;C&gt;");
    expect(gpx).not.toContain("A & B <C>");
  });

  it("findsToAdif emits a header + one record per find, with byte-correct field lengths", () => {
    const finds: ExpFind[] = [
      { code: "AC-0001", title: "Schlossberg", ownerCall: "OE8APR", stationCall: "OE8XYZ-9", ts: Date.UTC(2024, 5, 1, 12, 30, 5) / 1000 },
    ];
    const adif = findsToAdif(finds, "DL1ABC");
    expect(adif).toContain("<EOH>");
    expect(adif).toContain("<QSO_DATE:8>20240601");
    expect(adif).toContain("<TIME_ON:6>123005");
    expect(adif).toContain("<CALL:8>OE8XYZ-9");      // stationCall preferred, length 8
    expect(adif).toContain("<SIG:11>APRSCACHING");
    expect(adif).toContain("<SIG_INFO:7>AC-0001");
    expect(adif).toContain("<EOR>");
  });

  it("trackToKml emits a LineString of lon,lat,0 coordinates in order", () => {
    const kml = trackToKml("OE8XYZ-9", [
      { lat: 47.07, lon: 15.43, ts: 100, heardVia: "rf" },
      { lat: 47.08, lon: 15.44, ts: 200, heardVia: "aprs_is" },
    ]);
    expect(kml).toContain("<LineString>");
    expect(kml).toContain("<coordinates>15.43,47.07,0 15.44,47.08,0</coordinates>");
    expect(kml).toContain("<name>OE8XYZ-9</name>");
  });

  it("findsToAdif handles unicode comments without breaking field lengths", () => {
    const finds: ExpFind[] = [{ code: "OE-0789", title: "Schöckl", ownerCall: "OE6SOTA", stationCall: null, ts: 1717236000 }];
    const adif = findsToAdif(finds, "OE6SOTA");
    // "Found Schöckl (OE-0789)" — ö is 2 bytes in UTF-8, so the declared length must exceed the char count
    const m = /<COMMENT:(\d+)>/.exec(adif)!;
    expect(Number(m[1])).toBe(new TextEncoder().encode("Found Schöckl (OE-0789)").length);
  });
});
