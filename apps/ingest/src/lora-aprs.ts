// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * LoRa APRS port: a LoRa APRS iGate or modem on the operator's own network, read over TCP, receive only.
 *
 * The common LoRa APRS firmware (CA2RXU LoRa_APRS_iGate and LoRa_APRS_Tracker, SQ2CPA, and the OE5BPA
 * lineage they come from) does not send AX.25 on the air: a packet is the three bytes `0x3C 0xFF 0x01` (`<`,
 * 0xFF, 0x01) followed by a TNC2 text line, `SRC>DST,PATH:info`. CA2RXU's iGate firmware serves what its
 * LoRa radio hears on TCP port 8001 ("TNC server") in one of two forms, chosen by its KISS setting:
 *
 *   - `kiss` (the firmware's default): KISS frames, each the packet rendered as an AX.25 UI frame;
 *   - `text`: one TNC2 line per packet, ended by CR LF, the prefix stripped.
 *
 * The port reads either (`LORA_APRS_PROTOCOL`). Inside a KISS frame it also takes the packet as heard (the
 * prefix and the TNC2 line), and a bare TNC2 line, so a modem that passes the LoRa packet through unchanged
 * works as well.
 *
 * Trust is a TNC port's, nothing more: the frames are `rf`-heard on the `lora-aprs` port, and one heard
 * directly (no hop shows a relay) names the box's receiving site (`RF_SITE_CALL`), which the gateway attests
 * only when its sysop trusts that call. A LoRa digipeater marks the hop it used (`CALL*`), so a repeated
 * frame names no site. The iGate's "APRS-IS bridge" hands its TNC clients APRS-IS traffic too; a line that
 * came from APRS-IS carries a q-construct or `TCPIP` in its path, which no frame heard on the air does, and
 * the port drops it: an APRS-IS line must never read as this box's hearing. The signal report a transport
 * may add is display metadata, never a trust input.
 *
 * The port never transmits.
 */
import { decodeAx25, parseTNC2, type KissFrame, type ParsedFrame } from "@aprscaching/aprs";
import type { Packet } from "@aprscaching/shared";
import { isMeshcomNode, KissLink, TcpLink } from "./kiss.js";
import { tncPacket } from "./link.js";
import { LineBuffer } from "./lines.js";
import { numEnv } from "./config.js";
import { loraAirtimeMs, loraBitRate, type LoraModem } from "./lora-airtime.js";

/** The ingest port name of every frame this port hears. */
export const LORA_APRS_PORT = "lora-aprs";

/** The LoRa APRS packet prefix: `<`, 0xFF, 0x01. */
export const LORA_APRS_PREFIX = Uint8Array.of(0x3c, 0xff, 0x01);

export type LoraPreset = "standard" | "fast" | "custom";
export type LoraProtocol = "kiss" | "text";

/** The named modem settings. Custom takes its values from `LORA_APRS_SF`, `LORA_APRS_BW_KHZ`, `LORA_APRS_CR`. */
export const LORA_PRESETS: Record<Exclude<LoraPreset, "custom">, Pick<LoraModem, "sf" | "bwKhz" | "cr">> = {
  standard: { sf: 9, bwKhz: 125, cr: 7 },
  fast: { sf: 8, bwKhz: 125, cr: 6 },
};

/** LoRa APRS frequencies: IARU Region 1 and the UK. */
export const LORA_FREQ_REGION1_MHZ = 433.775;
export const LORA_FREQ_UK_MHZ = 439.9125;

/** The bandwidths a LoRa radio (SX127x, SX126x) offers, in kHz. */
const LORA_BANDWIDTHS_KHZ = [7.8, 10.4, 15.6, 20.8, 31.25, 41.7, 62.5, 125, 250, 500];

export interface LoraSettings extends LoraModem {
  preset: LoraPreset;
  /** The frequency the modem is set to, in MHz: shown in the status, never set on the modem. */
  freqMhz: number;
  protocol: LoraProtocol;
}

/**
 * The port's settings from the environment. The box does not configure the modem: the preset and frequency
 * say what it runs, for the status and the airtime. A Custom value outside what a LoRa radio offers stops the
 * start.
 */
export function loraSettings(env: Record<string, string | undefined>): LoraSettings {
  const preset = env.LORA_APRS_PRESET?.trim() || "standard";
  if (preset !== "standard" && preset !== "fast" && preset !== "custom")
    throw new Error(`LORA_APRS_PRESET=${preset} is not standard, fast or custom`);
  const protocol = env.LORA_APRS_PROTOCOL?.trim() || "kiss";
  if (protocol !== "kiss" && protocol !== "text") throw new Error(`LORA_APRS_PROTOCOL=${protocol} is not kiss or text`);
  const freqMhz = numEnv("LORA_APRS_FREQ_MHZ", LORA_FREQ_REGION1_MHZ, { min: 137, max: 1020 }, env);
  if (preset !== "custom") {
    const custom = ["LORA_APRS_SF", "LORA_APRS_BW_KHZ", "LORA_APRS_CR"].filter((k) => env[k]?.trim());
    if (custom.length)
      console.warn("[lora-aprs] %s apply only with LORA_APRS_PRESET=custom — ignored", custom.join(", "));
    return { preset, protocol, freqMhz, ...LORA_PRESETS[preset] };
  }
  const sf = numEnv("LORA_APRS_SF", LORA_PRESETS.standard.sf, { min: 7, max: 12 }, env);
  const bwKhz = numEnv("LORA_APRS_BW_KHZ", LORA_PRESETS.standard.bwKhz, {}, env);
  const cr = numEnv("LORA_APRS_CR", LORA_PRESETS.standard.cr, { min: 5, max: 8 }, env);
  if (!Number.isInteger(sf)) throw new Error(`LORA_APRS_SF=${sf} is not a whole number from 7 to 12`);
  if (!Number.isInteger(cr)) throw new Error(`LORA_APRS_CR=${cr} is not 5, 6, 7 or 8 (for 4:5 to 4:8)`);
  if (!LORA_BANDWIDTHS_KHZ.includes(bwKhz))
    throw new Error(`LORA_APRS_BW_KHZ=${bwKhz} is not a LoRa bandwidth (${LORA_BANDWIDTHS_KHZ.join(", ")})`);
  return { preset, protocol, freqMhz, sf, bwKhz, cr };
}

/** The length of a typical position beacon on the air, prefix included, for the status's airtime figure. */
export const LORA_REFERENCE_BYTES = 60;

const PRESET_NAME: Record<LoraPreset, string> = { standard: "Standard", fast: "Fast", custom: "Custom" };

/**
 * The port's status: frequency, preset, modem settings and what a typical packet costs on the air, e.g.
 * `433.775 MHz · Standard (BW 125 kHz, SF9, CR 4:7, 1256 bit/s) · a 60-byte packet is 484 ms on air`.
 */
export function loraStatus(s: Omit<LoraSettings, "protocol">): string {
  const ms = loraAirtimeMs(s, LORA_REFERENCE_BYTES);
  return (
    `${s.freqMhz} MHz · ${PRESET_NAME[s.preset]} (BW ${s.bwKhz} kHz, SF${s.sf}, CR 4:${s.cr}, ` +
    `${Math.round(loraBitRate(s))} bit/s) · a ${LORA_REFERENCE_BYTES}-byte packet is ${Math.round(ms)} ms on air`
  );
}

/**
 * The receiver's report of one packet, when the transport carries it. Neither of the iGate's TNC forms
 * carries one (KISS has no field for it, the text line is the packet alone), so these stay optional for a
 * transport that does.
 */
export interface LoraRxMeta {
  /** Received signal strength, dBm. */
  rssi?: number;
  /** Signal-to-noise ratio, dB. */
  snr?: number;
  /** Frequency error of the received packet, Hz. */
  freqOffsetHz?: number;
}

/** The report with each field kept only when it is a plausible number; undefined when none is. */
export function sanitizeLoraMeta(m: LoraRxMeta | undefined): LoraRxMeta | undefined {
  if (!m) return undefined;
  const ok = (v: unknown, lo: number, hi: number) =>
    typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi ? v : undefined;
  const out: LoraRxMeta = {};
  const rssi = ok(m.rssi, -200, 20);
  const snr = ok(m.snr, -40, 40);
  const foff = ok(m.freqOffsetHz, -250_000, 250_000);
  if (rssi !== undefined) out.rssi = rssi;
  if (snr !== undefined) out.snr = snr;
  if (foff !== undefined) out.freqOffsetHz = foff;
  return Object.keys(out).length ? out : undefined;
}

/** How the packet reached the port: the LoRa packet as heard, an AX.25 rendering of it, or a bare TNC2 line. */
export type LoraForm = "lora" | "ax25" | "text";

export interface LoraDecoded {
  frame: ParsedFrame;
  form: LoraForm;
  /** The packet's length on the air, prefix included (rebuilt from the line for an AX.25 rendering). */
  airBytes: number;
}

/**
 * One character per byte (ISO-8859-1), the way every other port posts what it heard: the gateway reads the text
 * as UTF-8 where the bytes are valid UTF-8 (`rfText`). TextDecoder's "latin1" is windows-1252 and remaps
 * 0x80–0x9F, so Buffer's encoding is used.
 */
const latin1 = (b: Uint8Array) => Buffer.from(b).toString("latin1");

/** A TNC2 line from LoRa bytes; a trailing CR, LF or NUL is dropped. */
function parseLine(b: Uint8Array): ParsedFrame | null {
  const line = latin1(b).replace(/[\r\n\0]+$/, "");
  // one line: a frame with a line break or another control character in it is not a TNC2 line
  if (!line || /[\x00-\x1f]/.test(line)) return null;
  const f = parseTNC2(line);
  if (!f || !f.src || !f.dst || !f.payload) return null;
  // an address is a callsign or an alias, never text with spaces
  if (![f.src, f.dst, ...f.path].every((a) => /^[A-Za-z0-9-]{1,16}\*?$/.test(a))) return null;
  return f;
}

const startsWithPrefix = (b: Uint8Array) =>
  b.length > 3 && b[0] === LORA_APRS_PREFIX[0] && b[1] === LORA_APRS_PREFIX[1] && b[2] === LORA_APRS_PREFIX[2];

/** Decode one LoRa packet as it reached the port: the prefixed line, an AX.25 rendering, or a bare line. */
export function decodeLoraPacket(b: Uint8Array): LoraDecoded | null {
  if (startsWithPrefix(b)) {
    const frame = parseLine(b.subarray(LORA_APRS_PREFIX.length));
    return frame ? { frame, form: "lora", airBytes: b.length } : null;
  }
  const ax = decodeAx25(b);
  if (ax) {
    const head = `${ax.src}>${ax.dst}${ax.path.length ? "," + ax.path.join(",") : ""}`;
    const frame = { ...ax, raw: `${head}:${ax.payload}` };
    return { frame, form: "ax25", airBytes: LORA_APRS_PREFIX.length + frame.raw.length };
  }
  const frame = parseLine(b);
  return frame ? { frame, form: "text", airBytes: LORA_APRS_PREFIX.length + b.length } : null;
}

/**
 * Whether a frame came from APRS-IS rather than the air: its path holds a q-construct (`qAR`, `qAC`, …) or
 * `TCPIP`/`TCPXX`, which only an APRS-IS server or client adds.
 */
export const fromAprsIs = (f: Pick<ParsedFrame, "path">): boolean =>
  f.path.some((h) => /^q[A-Z]{2}$/i.test(h) || /^TCP(IP|XX)\*?$/i.test(h));

/**
 * The ingest packet for a LoRa frame the box's own modem heard: a TNC port's packet on the `lora-aprs` port,
 * stamped with the site when heard directly, with the receiver's report as metadata when there is one.
 */
export function loraPacket(f: ParsedFrame, siteCall: string | undefined, ts: number, meta?: LoraRxMeta): Packet {
  const p = tncPacket(f, LORA_APRS_PORT, siteCall, ts);
  const m = sanitizeLoraMeta(meta);
  return m ? { ...p, parsed: { lora: m } } : p;
}

export interface LoraAprsOpts {
  host: string;
  port: number;
  settings: LoraSettings;
  /** This box's receiving-site callsign, stamped on frames heard directly. */
  siteCall?: string;
  retryMs?: number;
  /** How often the counters are logged, in ms; 0 never. */
  statsMs?: number;
  log?: Pick<Console, "log" | "error">;
  /** Called for each packet that is neither a TNC2 line nor an AX.25 frame, for the port's health. */
  onInvalid?: () => void;
}

export interface LoraStats {
  received: number;
  decoded: number;
  /** Not a TNC2 or AX.25 packet. */
  rejected: number;
  /** APRS-IS lines the iGate passed on, dropped. */
  fromAprsIs: number;
  forms: Record<LoraForm, number>;
  /** Time on air of the packets heard, ms. */
  airtimeMs: number;
}

/** Longest line the text form keeps: a LoRa packet is at most 255 bytes. */
const LINE_MAX = 1024;

/** A LoRa APRS iGate's TNC server, or a LoRa KISS modem, over TCP; receive only. */
export class LoraAprsPort {
  private link: { start(): void; stop(): void };
  private log: Pick<Console, "log" | "error">;
  private meshcomNode = false;
  private timer?: ReturnType<typeof setInterval>;
  private since = Date.now();
  readonly stats: LoraStats = {
    received: 0,
    decoded: 0,
    rejected: 0,
    fromAprsIs: 0,
    forms: { lora: 0, ax25: 0, text: 0 },
    airtimeMs: 0,
  };

  constructor(
    private o: LoraAprsOpts,
    private onPacket: (p: Packet) => void,
  ) {
    this.log = o.log ?? console;
    const tcp = { host: o.host, port: o.port, retryMs: o.retryMs, tag: "lora-aprs" };
    if (o.settings.protocol === "text") {
      const lines = new LineBuffer(LINE_MAX);
      this.link = new TcpLink(tcp, {
        onOpen: () => lines.reset(),
        onChunk: (c) => {
          for (const l of lines.push(c.toString("latin1"))) if (l) this.onBytes(Buffer.from(l, "latin1"));
        },
      });
    } else {
      this.link = new KissLink(tcp, (k) => this.onKiss(k));
    }
  }

  start(): void {
    this.since = Date.now();
    this.link.start();
    const every = this.o.statsMs ?? 10 * 60_000;
    if (every > 0) {
      this.timer = setInterval(() => this.log.log("[lora-aprs] stats %s", JSON.stringify(this.counters())), every);
      this.timer.unref();
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.link.stop();
  }

  /** The settings and the airtime of a typical packet: the line the box logs at start. */
  status(): string {
    return loraStatus(this.o.settings);
  }

  /** The counters, with the share of time the heard packets kept the channel busy since the start. */
  counters(now = Date.now()): LoraStats & { channelPct: number } {
    const elapsed = Math.max(1, now - this.since);
    return { ...this.stats, channelPct: Math.round((this.stats.airtimeMs / elapsed) * 10_000) / 100 };
  }

  /** One KISS data frame. */
  onKiss(k: KissFrame, meta?: LoraRxMeta): void {
    if (this.meshcomNode) return;
    const ax = decodeAx25(k.frame);
    if (isMeshcomNode(k, ax?.dst)) {
      // a MeshCom node's frames are not this box's hearings: its relays arrive as if heard directly
      this.meshcomNode = true;
      this.log.error(
        "[lora-aprs] %s:%s is a MeshCom node, not a LoRa APRS iGate: its frames are ignored. Listen to the node with MESHCOM_NODE instead.",
        this.o.host,
        this.o.port,
      );
      return;
    }
    this.onBytes(k.frame, meta);
  }

  /** One packet's bytes, from a KISS frame or a text line. */
  onBytes(b: Uint8Array, meta?: LoraRxMeta): void {
    this.stats.received++;
    const d = decodeLoraPacket(b);
    if (!d) {
      this.stats.rejected++;
      this.o.onInvalid?.();
      return;
    }
    if (fromAprsIs(d.frame)) {
      this.stats.fromAprsIs++;
      return;
    }
    this.stats.decoded++;
    this.stats.forms[d.form]++;
    this.stats.airtimeMs += loraAirtimeMs(this.o.settings, d.airBytes);
    this.onPacket(loraPacket(d.frame, this.o.siteCall, Math.floor(Date.now() / 1000), meta));
  }
}
