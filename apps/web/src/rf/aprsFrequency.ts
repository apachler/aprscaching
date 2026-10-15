// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The APRS frequency hint of My radio, as text: the operator's country from their callsign's prefix, else the
 * region of the browser's locale (`de-AT` → Austria). A hint only: the app never tunes a radio by it.
 */
import { HF_APRS } from "@aprscaching/aprs";
import { ISS_APRS_MHZ, LORA_APRS_MHZ, aprsFrequencyHint } from "@aprscaching/shared";

/** The region a locale names explicitly (`de-AT` → `AT`); undefined for a bare language such as `de`. */
export function localeRegion(locale: string): string | undefined {
  try {
    return new Intl.Locale(locale).region;
  } catch {
    return undefined;
  }
}

/** A frequency the way radios show it, three decimals in the locale's notation: `144.800`, `144,800`. */
export function formatMhz(mhz: number, locale: string): string {
  return new Intl.NumberFormat(locale, { minimumFractionDigits: 3, maximumFractionDigits: 3 }).format(mhz);
}

/** The HF dial frequency to the 100 Hz an SSB radio needs: `10.1476`. */
const hfDial = (locale: string): string =>
  new Intl.NumberFormat(locale, { minimumFractionDigits: 4, maximumFractionDigits: 4 }).format(HF_APRS.dialMhz);

/** A country's English name by its ISO 3166 code, or the code itself where Intl has no names. */
function countryName(iso: string): string {
  try {
    return new Intl.DisplayNames(["en"], { type: "region" }).of(iso) ?? iso;
  } catch {
    return iso;
  }
}

export interface FrequencyLines {
  /** `APRS in Austria: 144.800 MHz`, or null when the operator's country has no checked value. */
  aprs: string | null;
  lora: string;
  iss: string;
  /** The 30 m channel: the dial frequency with its sideband, and the modem's baud rate and tones. */
  hf: string;
}

/** The hint's lines for an operator's callsign (may be empty) and locale. */
export function frequencyLines(call: string, locale: string): FrequencyLines {
  const f = aprsFrequencyHint({ call, localeRegion: localeRegion(locale) });
  const place = f ? (f.country ? countryName(f.country) : (f.entity?.name ?? "Europe")) : "";
  return {
    aprs: f ? `APRS in ${place}: ${formatMhz(f.mhz, locale)} MHz` : null,
    lora: `LoRa APRS: ${formatMhz(LORA_APRS_MHZ, locale)} MHz, the IARU Region 1 channel`,
    iss: `ISS digipeater: ${formatMhz(ISS_APRS_MHZ, locale)} MHz, worldwide`,
    hf: `HF APRS: ${hfDial(locale)} MHz ${HF_APRS.mode} dial, ${HF_APRS.modem.baud} baud, ${HF_APRS.modem.mark}/${HF_APRS.modem.space} Hz tones, worldwide`,
  };
}
