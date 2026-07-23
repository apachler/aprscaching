// SPDX-License-Identifier: MIT
import type { SymbolInfo } from "./symbols.js";

export interface ParsedFrame {
  src: string;
  dst: string;
  path: string[];
  payload: string;
  raw: string;
}

// ---- decoded APRS data (APRS101 data-type identifiers) ----
export interface DecodedPosition {
  lat: number;
  lon: number;
  symbol?: SymbolInfo;
  course?: number;
  speedKn?: number;
  altitudeM?: number;
  comment?: string;
  ambiguity?: number;
  messageType?: string; // MIC-E standard/custom message
  timestamp?: string; // raw timestamp token when present
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
  ack?: boolean;
  rej?: boolean;
  bulletin?: string;
}

export type AprsData =
  | ({ kind: "position" } & DecodedPosition)
  | ({ kind: "object"; name: string; alive: boolean } & Partial<DecodedPosition>)
  | ({ kind: "item"; name: string; alive: boolean } & Partial<DecodedPosition>)
  | ({ kind: "weather" } & DecodedWeather & Partial<DecodedPosition>)
  | ({ kind: "telemetry" } & DecodedTelemetry)
  | ({ kind: "message" } & DecodedMessage)
  | { kind: "status"; text: string }
  | { kind: "other" };
