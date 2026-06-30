import { describe, it, expect } from "vitest";
import { parseWx, wxUrls, makeWxKey } from "../src/wx.js";

const bag = (o: Record<string, string>) => (k: string) => o[k.toLowerCase()];

describe("weather W1 — Ecowitt/WU parse (docs/17)", () => {
  it("converts an Ecowitt 'customized' push (imperial → metric)", () => {
    const wx = parseWx(bag({ tempf: "68", humidity: "55", baromrelin: "29.92", windspeedmph: "10", windgustmph: "15", winddir: "180", hourlyrainin: "0.1", dailyrainin: "0.5", solarradiation: "500" }));
    expect(wx.temp_c).toBe(20);
    expect(wx.humidity).toBe(55);
    expect(wx.pressure_hpa).toBeCloseTo(1013.2, 0);
    expect(wx.wind_kn).toBeCloseTo(8.7, 1);
    expect(wx.gust_kn).toBeCloseTo(13, 0);
    expect(wx.wind_dir).toBe(180);
    expect(wx.rain_mm).toBeCloseTo(2.54, 1);
    expect(wx.rain_24h_mm).toBeCloseTo(12.7, 1);
    expect(wx.luminosity_wm2).toBe(500);
  });

  it("accepts WU-Rapidfire field aliases (baromin, rainin)", () => {
    const wx = parseWx(bag({ tempf: "32", baromin: "30.00", rainin: "0", windspeed: "0" }));
    expect(wx.temp_c).toBe(0);
    expect(wx.pressure_hpa).toBeCloseTo(1015.9, 0);
    expect(wx.rain_mm).toBe(0);
  });

  it("omits absent fields", () => {
    const wx = parseWx(bag({ humidity: "40" }));
    expect(wx.humidity).toBe(40);
    expect(wx.temp_c).toBeUndefined();
    expect(wx.pressure_hpa).toBeUndefined();
  });
});

describe("weather W1 — paste URLs + key format (the exact strings a PWS is pointed at)", () => {
  it("wxUrls builds the Ecowitt path + WU-Rapidfire URL with the station id encoded", () => {
    const u = wxUrls("https://api.aprscaching.net", "OE8APR-13", "wx_abc123");
    expect(u.ecowittPath).toBe("https://api.aprscaching.net/api/wx/submit?key=wx_abc123");
    expect(u.wuUrl).toBe("https://api.aprscaching.net/api/wx/updateweatherstation?ID=OE8APR-13&PASSWORD=wx_abc123");
    // the WU ID carries a callsign-SSID; '-' is safe but the station must be URL-encoded in general
    expect(wxUrls("https://x", "OE8/P-13", "k").wuUrl).toContain("ID=OE8%2FP-13&PASSWORD=k");
  });

  it("makeWxKey is a prefixed 24-hex token and unique per call", () => {
    const k = makeWxKey();
    expect(k).toMatch(/^wx_[0-9a-f]{24}$/);
    expect(makeWxKey()).not.toBe(k);
  });
});
