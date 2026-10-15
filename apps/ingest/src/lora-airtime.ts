// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * LoRa time on air, from the modem settings and the packet length (Semtech AN1200.13, the SX127x data sheet):
 *
 *   Tsym      = 2^SF / BW
 *   Tpreamble = (Npreamble + 4.25) · Tsym
 *   Npayload  = 8 + max(ceil((8·PL − 4·SF + 28 + 16·CRC − 20·IH) / (4·(SF − 2·DE))) · (CR + 4), 0)
 *   Tpacket   = Tpreamble + Npayload · Tsym
 *
 * PL is the payload in bytes (the LoRa APRS prefix included), CR is 1–4 for the coding rates 4/5–4/8, IH is 1
 * for an implicit header, CRC is 1 when the payload CRC is on, and DE is 1 when low-data-rate optimisation is
 * on. The radio needs that optimisation when a symbol lasts longer than 16 ms (SF11 and SF12 at 125 kHz), and
 * the LoRa APRS firmware switches it on there, so it follows the symbol time unless set.
 *
 * Pure: no I/O, so the port's status and the tests share it.
 */

export interface LoraModem {
  /** Spreading factor, 7–12. */
  sf: number;
  /** Bandwidth in kHz (125, 250, 62.5, …). */
  bwKhz: number;
  /** Coding rate denominator: 5–8 for 4/5–4/8. */
  cr: number;
  /** Preamble length in symbols; LoRa APRS uses 8. */
  preamble?: number;
  /** Explicit header (LoRa APRS) unless false. */
  explicitHeader?: boolean;
  /** Payload CRC on (LoRa APRS) unless false. */
  crc?: boolean;
  /** Low-data-rate optimisation; follows the symbol time when unset. */
  lowDataRate?: boolean;
}

/** The duration of one symbol, in milliseconds. */
export const loraSymbolMs = (m: Pick<LoraModem, "sf" | "bwKhz">): number => 2 ** m.sf / m.bwKhz;

/** Time on air of one packet of `payloadBytes` bytes, in milliseconds. */
export function loraAirtimeMs(m: LoraModem, payloadBytes: number): number {
  const tSym = loraSymbolMs(m);
  const de = (m.lowDataRate ?? tSym > 16) ? 1 : 0;
  const ih = m.explicitHeader === false ? 1 : 0;
  const crc = m.crc === false ? 0 : 1;
  const cr = m.cr - 4;
  const pl = Math.max(0, Math.floor(payloadBytes));
  const bits = 8 * pl - 4 * m.sf + 28 + 16 * crc - 20 * ih;
  const nPayload = 8 + Math.max(Math.ceil(bits / (4 * (m.sf - 2 * de))) * (cr + 4), 0);
  return ((m.preamble ?? 8) + 4.25) * tSym + nPayload * tSym;
}

/**
 * The raw bit rate the settings carry, in bits per second: SF · (BW / 2^SF) · (4 / CR). A preset is known by
 * it; the time on air above is what a packet costs, preamble and header included.
 */
export const loraBitRate = (m: Pick<LoraModem, "sf" | "bwKhz" | "cr">): number =>
  (m.sf * ((m.bwKhz * 1000) / 2 ** m.sf) * 4) / m.cr;
