// SPDX-License-Identifier: MIT
import type { SymbolInfo } from "./symbols.js";

export interface ParsedFrame {
  src: string;
  dst: string;
  path: string[];
  payload: string;
  raw: string;
}

/**
 * The raw device code a Mic-E status text carries: `prefix` is its first character (`>` `]` for Kenwood, `` ` ``
 * `'` for other makers) and `suffix` the characters at its end where the code sits (one after a Kenwood prefix,
 * two after the others, empty when the text is too short). The decoder strips the codes it knows from the
 * comment; naming the device is the device table's job (`identifyDevice` in deviceid.ts).
 */
export interface MicEDeviceCode {
  prefix: string;
  suffix: string;
}

// ---- decoded APRS data (APRS101 data-type identifiers) ----
export interface DecodedPosition {
  lat: number;
  lon: number;
  symbol?: SymbolInfo;
  course?: number;
  speedKn?: number;
  altitudeM?: number;
  /**
   * The station's radio range: pre-calculated (an RNG extension or a compressed position's range byte) or
   * worked out from its PHG.
   */
  rangeKm?: number;
  /** Transmitter power and antenna height, gain and directivity (the PHG extension). */
  phg?: PowerHeightGain;
  /** A DF station's omni signal report (the DFS extension): how strongly it hears the signal it hunts. */
  dfs?: DfSignal;
  /** A DF report's bearing and its number, range and quality (`/BRG/NRQ`), sent with the DF symbol. */
  df?: DfBearing;
  comment?: string;
  /** Position ambiguity, 0–4: how many trailing minute digits the station left out, in both coordinates. */
  ambiguity?: number;
  messageType?: string; // MIC-E standard/custom message
  /** A Mic-E position's raw device code (prefix and suffix of its status text), for the device table. */
  micEDevice?: MicEDeviceCode;
  timestamp?: string; // raw timestamp token when present
}
/** The PHG extension, `PHGphgd`, or its probe form `PHGphgdR/` with a beacon rate. */
export interface PowerHeightGain {
  /** Transmitter power in watts: the power code squared. */
  powerW: number;
  /** Antenna height above the average local terrain, in metres: 10 ft, doubled per step of the height code. */
  heightM: number;
  /** Antenna gain in dB. */
  gainDb: number;
  /** The direction of maximum gain in degrees (45–360); absent for an omni antenna. */
  directivityDeg?: number;
  /** Beacons per hour, from the probe form's rate character (`1`–`9`, then `A` for 10 onwards). */
  beaconsPerHour?: number;
}
/** The DFS extension, `DFSshgd`: a PHG whose power code is the strength of the signal a DF station hears. */
export interface DfSignal {
  /** Relative signal strength, S0–S9; S0 marks a place the signal is not heard. */
  strength: number;
  heightM: number;
  gainDb: number;
  directivityDeg?: number;
}
/** A DF report's `/BRG/NRQ`: the bearing to the signal and how far to trust it. */
export interface DfBearing {
  bearingDeg: number;
  /** Hits per period in eighths, 1–8 (8: every sample hit); absent when the NRQ is meaningless or manual. */
  hits?: number;
  /** The bearing was taken by hand (N = 9). */
  manual?: boolean;
  /** How far the bearing line reaches: 2^R miles. */
  rangeKm?: number;
  /** The beamwidth the bearing lies within (Q 1–9: under 240° down to under 1°); absent at Q 0, useless. */
  accuracyDeg?: number;
}
export interface DecodedWeather {
  tempC?: number;
  windDirDeg?: number;
  windKn?: number;
  gustKn?: number;
  humidity?: number;
  pressureHpa?: number;
  rain1hMm?: number;
  rain24hMm?: number;
  rainMidnightMm?: number;
}
export interface DecodedTelemetry {
  seq?: number;
  analog: number[];
  digital: boolean[];
}
export interface DecodedMessage {
  addressee: string;
  text: string;
  msgNo?: string;
  /** A reply-ack (`{MM}AA`): the sender's acknowledgement of our message number AA, carried in its own message. */
  replyAck?: string;
  ack?: boolean;
  rej?: boolean;
  bulletin?: string;
}

export type AprsData =
  | ({ kind: "position" } & DecodedPosition)
  | ({ kind: "object"; name: string; alive: boolean } & Partial<DecodedPosition> & Partial<DecodedWeather>)
  | ({ kind: "item"; name: string; alive: boolean } & Partial<DecodedPosition> & Partial<DecodedWeather>)
  | ({ kind: "weather" } & DecodedWeather & Partial<DecodedPosition>)
  | ({ kind: "telemetry" } & DecodedTelemetry)
  | ({ kind: "message" } & DecodedMessage)
  | { kind: "status"; text: string; timestamp?: string }
  /**
   * Third-party traffic (`}`): a packet another station or gateway carries for its sender. `inner` is that
   * packet's header and `data` its decoded content, attributed to `inner.src`, never to the carrier.
   */
  | { kind: "thirdparty"; inner: ParsedFrame; data: AprsData }
  | { kind: "other" };
