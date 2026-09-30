// SPDX-License-Identifier: MIT
/**
 * MeshCom hardware ids → device names, for the map's node details. The ids are the firmware's
 * `BOARD_HARDWARE` values (icssw-org/MeshCom-Firmware, MIT, `src/configuration_global.h`); the names are
 * the devices those constants stand for. New firmware adds ids: an unknown one reads "Unknown device
 * (ID n)" until this table learns it.
 */
const HARDWARE: Readonly<Record<number, string>> = {
  1: "LilyGO T-LoRa V2",
  2: "LilyGO T-LoRa V1",
  3: "LilyGO T-LoRa V2.1-1.6",
  4: "LilyGO T-Beam",
  5: "LilyGO T-Beam (SX1268)",
  6: "LilyGO T-Beam V0.7",
  7: "LilyGO T-Echo",
  8: "LilyGO T-Deck",
  9: "RAK WisBlock RAK4631",
  10: "Heltec WiFi LoRa 32 V2.1",
  11: "Heltec WiFi LoRa 32 V1",
  12: "LilyGO T-Beam (AXP2101)",
  39: "EBYTE E22 module",
  40: "LilyGO T5 e-paper",
  41: "Heltec Wireless Tracker",
  42: "Heltec Wireless Stick V3",
  43: "Heltec WiFi LoRa 32 V3",
  44: "Heltec Vision Master E290",
  45: "LilyGO T-Beam (SX1262)",
  46: "LilyGO T-Deck Plus",
  47: "LilyGO T-Beam Supreme",
  48: "ESP32-S3 with EBYTE E22",
  49: "LilyGO T-LoRa Pager",
  50: "LilyGO T-Deck Pro",
  51: "LilyGO T-Beam 1W",
  52: "Heltec WiFi LoRa 32 V4",
  53: "LilyGO T-ETH Elite (SX1262)",
  54: "Heltec Mesh Node T114",
  55: "LilyGO T3-S3 V1.3",
  56: "LilyGO T-Connect Pro",
  57: "Heltec Wireless Paper",
  58: "Heltec Vision Master E213",
  59: "ESP32 LoRa APRS (E22)",
  60: "ESP32 LoRa APRS (Ra-01)",
  61: "LilyGO T-Watch S3",
};

/** The device name for a MeshCom hardware id, or "Unknown device (ID n)". */
export function meshcomHardwareName(id: number): string {
  return HARDWARE[id] ?? `Unknown device (ID ${id})`;
}
