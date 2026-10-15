// SPDX-License-Identifier: MIT
/**
 * The APRS frequency of a country, for a hint beside the operator's radio: never set on a radio by itself.
 *
 * Sources, checked against each value below:
 * - The VHF table of Wikipedia's "Automatic Packet Reporting System" article
 *   (https://en.wikipedia.org/wiki/Automatic_Packet_Reporting_System, "Frequencies"): 144.390 MHz in North
 *   America, Argentina, Colombia, Chile, Indonesia, Malaysia, Singapore and Thailand; 144.575 New Zealand;
 *   144.640 China and Taiwan; 144.660 Japan; 144.800 South Africa, Europe and Russia; 144.930 Uruguay and
 *   Panama; 145.175 Australia; 145.570 Brazil.
 * - ARISS (https://www.ariss.org/contact-the-iss.html): the ISS packet digipeater on 145.825 MHz, worldwide.
 * - The IARU Region 1 band plan: 433.775 MHz is the LoRa APRS channel.
 * A country missing from the table has no answer, apart from Europe, where the IARU Region 1 plan puts APRS on
 * 144.800 MHz: a wrong hint is worse than none.
 */
import { dxccOfCall, type DxccEntity } from "./dxcc.js";

/** The LoRa APRS channel of IARU Region 1, MHz. */
export const LORA_APRS_MHZ = 433.775;
/** The ISS packet digipeater, uplink and downlink, worldwide, MHz. */
export const ISS_APRS_MHZ = 145.825;
/** APRS in Europe, the IARU Region 1 channel, MHz. */
const EUROPE_MHZ = 144.8;

/** Each country by its ISO 3166 code: its APRS frequency and the DXCC primary prefixes its callsigns carry. */
const COUNTRIES: Readonly<Record<string, { mhz: number; dxcc: readonly string[] }>> = {
  US: { mhz: 144.39, dxcc: ["K", "KL"] },
  CA: { mhz: 144.39, dxcc: ["VE"] },
  MX: { mhz: 144.39, dxcc: ["XE"] },
  AR: { mhz: 144.39, dxcc: ["LU"] },
  CO: { mhz: 144.39, dxcc: ["HK"] },
  CL: { mhz: 144.39, dxcc: ["CE"] },
  ID: { mhz: 144.39, dxcc: ["YB"] },
  MY: { mhz: 144.39, dxcc: ["9M2", "9M6"] },
  SG: { mhz: 144.39, dxcc: ["9V"] },
  TH: { mhz: 144.39, dxcc: ["HS"] },
  NZ: { mhz: 144.575, dxcc: ["ZL"] },
  CN: { mhz: 144.64, dxcc: ["BY"] },
  TW: { mhz: 144.64, dxcc: ["BV"] },
  JP: { mhz: 144.66, dxcc: ["JA"] },
  ZA: { mhz: 144.8, dxcc: ["ZS"] },
  RU: { mhz: 144.8, dxcc: ["UA", "UA2", "UA9"] },
  UY: { mhz: 144.93, dxcc: ["CX"] },
  PA: { mhz: 144.93, dxcc: ["HP"] },
  AU: { mhz: 145.175, dxcc: ["VK"] },
  BR: { mhz: 145.57, dxcc: ["PY"] },
};

/** The ISO 3166 codes of Europe, where the IARU Region 1 plan puts APRS on 144.800 MHz. */
const EUROPE = new Set(
  (
    "AD AL AT AX BA BE BG BY CH CY CZ DE DK EE ES FI FO FR GB GG GI GR HR HU IE IM IS IT JE LI LT LU LV MC MD ME " +
    "MK MT NL NO PL PT RO RS SE SI SJ SK SM UA VA XK"
  ).split(" "),
);

const BY_DXCC = new Map<string, string>();
for (const [iso, c] of Object.entries(COUNTRIES)) for (const p of c.dxcc) BY_DXCC.set(p, iso);

/** A suggested APRS frequency and where it applies. */
export interface AprsFrequency {
  mhz: number;
  /** The ISO 3166 country code, when the answer names a country. */
  country?: string;
  /** The DXCC entity the operator's callsign names, when the answer comes from the callsign. */
  entity?: DxccEntity;
  /** Where the answer comes from: the country's own entry, or the European default. */
  basis: "country" | "europe";
}

/** The APRS frequency of a country by its ISO 3166 code, any case; undefined when the table has no answer. */
export function aprsFrequencyForCountry(iso: string): AprsFrequency | undefined {
  const code = iso.trim().toUpperCase();
  const c = COUNTRIES[code];
  if (c) return { mhz: c.mhz, country: code, basis: "country" };
  if (EUROPE.has(code)) return { mhz: EUROPE_MHZ, country: code, basis: "europe" };
  return undefined;
}

/**
 * The APRS frequency where a callsign operates, by its DXCC entity: `OE8APR` → 144.800 (Europe), `W1AW` →
 * 144.390, `VK2ABC` → 145.175. Undefined for an entity the table does not name outside Europe.
 */
export function aprsFrequencyForCall(call: string): AprsFrequency | undefined {
  const entity = dxccOfCall(call);
  if (!entity) return undefined;
  const iso = BY_DXCC.get(entity.prefix.toUpperCase());
  if (iso) return { mhz: COUNTRIES[iso]!.mhz, country: iso, entity, basis: "country" };
  if (entity.continent === "EU") return { mhz: EUROPE_MHZ, entity, basis: "europe" };
  return undefined;
}

/**
 * The operator's APRS frequency: the callsign's prefix names its country first, since a callsign is issued by
 * one; the browser locale's region (`de-AT` → `AT`) answers only when the callsign does not.
 */
export function aprsFrequencyHint(o: { call?: string; localeRegion?: string }): AprsFrequency | undefined {
  return (
    (o.call ? aprsFrequencyForCall(o.call) : undefined) ??
    (o.localeRegion ? aprsFrequencyForCountry(o.localeRegion) : undefined)
  );
}
