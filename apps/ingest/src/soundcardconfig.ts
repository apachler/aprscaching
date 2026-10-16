// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The soundcard ports from the ingest's settings. `SOUNDCARD_DEVICE` turns on the first port, named `1`, and
 * the other `SOUNDCARD_*` keys configure it. `SOUNDCARD_PORTS` adds more, as a JSON array of objects whose
 * fields mirror those keys (`device` is required, `name` defaults to the port's number):
 *
 *   [{"name":"uhf","device":"plughw:2,0","tx":true,"ptt":"cm108:/dev/hidraw1"}]
 *
 * A further port takes its rate, modem, framing, timing, level and call from the `SOUNDCARD_*` keys unless it
 * sets its own, but never `tx` or `ptt`: transmit is an opt-in per port.
 *
 * `SOUNDCARD_MODEM` picks the modem: `1200` (Bell 202, VHF and UHF FM, the default), `hf300` (300 baud,
 * 1600/1800 Hz, through an SSB radio on HF) or `9600` (G3RUH, through a radio's 9600-capable data port). An
 * `hf300` port takes a TXDELAY long enough for an HF radio's transmit-receive switching unless a setting names
 * one. Every port runs Direwolf's modem. `SOUNDCARD_FEC` picks the transmit framing (`off`, `fx25`, `il2p`) and
 * `SOUNDCARD_FX25_CHECK_BYTES` the FX.25 code (16, 32 or 64); every port receives all three.
 */
import { numEnv } from "./config.js";
import { parsePttSpec } from "./ptt/index.js";
import type { SoundcardConfig } from "./soundcard.js";
import type { SoundcardFec, SoundcardModem } from "./soundcardmodem.js";

export interface SoundcardPortSettings extends SoundcardConfig {
  /** The call this port transmits under (`SOUNDCARD_CALL`, default `BOX_CALL`, `IGATE_CALL`, `DIGI_CALL`). */
  call?: string;
}

const RANGES = {
  txDelayMs: { key: "SOUNDCARD_TXDELAY_MS", def: 300, min: 10, max: 1000 },
  txTailMs: { key: "SOUNDCARD_TXTAIL_MS", def: 50, min: 0, max: 500 },
  persist: { key: "SOUNDCARD_PERSIST", def: 63, min: 0, max: 255 },
  slotTimeMs: { key: "SOUNDCARD_SLOTTIME_MS", def: 100, min: 10, max: 1000 },
  pttMaxMs: { key: "SOUNDCARD_PTT_MAX_MS", def: 10_000, min: 1000, max: 60_000 },
  txLevel: { key: "SOUNDCARD_TX_LEVEL", def: 0.5, min: 0.01, max: 1 },
  dutyPct: { key: "SOUNDCARD_DUTY_PCT", def: 20, min: 1, max: 100 },
} as const;
type RangedField = keyof typeof RANGES;

const RATES = [44100, 48000];
const MODEMS: readonly SoundcardModem[] = ["1200", "hf300", "9600"];
const FECS: readonly SoundcardFec[] = ["off", "fx25", "il2p"];
const CHECK_BYTES = [16, 32, 64] as const;
/** The TXDELAY an `hf300` port takes when no setting names one: an HF radio's relays switch slower than an FM rig's. */
const HF_TXDELAY_MS = 500;
const FIELDS = new Set([
  "name",
  "device",
  "playback",
  "rate",
  "modem",
  "fec",
  "fx25CheckBytes",
  "tx",
  "ptt",
  "call",
  ...Object.keys(RANGES),
]);

function oneOf<T extends string>(list: readonly T[], raw: unknown, at: string): T {
  const m = String(raw).trim();
  if (!(list as readonly string[]).includes(m)) throw new Error(`${at}: expected ${list.join(", ")}`);
  return m as T;
}

function readCheckBytes(raw: unknown, at: string): 16 | 32 | 64 {
  const n = Number(String(raw).trim());
  const hit = CHECK_BYTES.find((c) => c === n);
  if (hit === undefined) throw new Error(`${at}: expected ${CHECK_BYTES.join(", ")}`);
  return hit;
}

/** The modem fields a further port inherits unless it sets its own. */
interface ModemFields {
  modem: SoundcardModem;
  fec: SoundcardFec;
  fx25CheckBytes: 16 | 32 | 64;
}

/** The HF TXDELAY for an `hf300` port whose settings name none. */
const hfTxDelay = (modem: SoundcardModem, set: boolean) =>
  modem === "hf300" && !set ? { txDelayMs: HF_TXDELAY_MS } : {};
const CALL_RE = /^[A-Z0-9]{1,6}(?:-(?:1[0-5]|[0-9]))?$/i;

/** Every soundcard port the settings describe; throws with the setting at fault. */
export function soundcardPorts(env: Record<string, string | undefined>): SoundcardPortSettings[] {
  const ranged = Object.fromEntries(
    (Object.keys(RANGES) as RangedField[]).map((f) => {
      const r = RANGES[f];
      return [f, numEnv(r.key, r.def, { min: r.min, max: r.max }, env)];
    }),
  ) as Record<RangedField, number>;
  const rate = env.SOUNDCARD_RATE?.trim() ? Number(env.SOUNDCARD_RATE) : 48000;
  if (!RATES.includes(rate)) throw new Error(`SOUNDCARD_RATE: expected ${RATES.join(" or ")}`);
  const modem = env.SOUNDCARD_MODEM?.trim() ? oneOf(MODEMS, env.SOUNDCARD_MODEM, "SOUNDCARD_MODEM") : "1200";
  const fields: ModemFields = {
    modem,
    fec: env.SOUNDCARD_FEC?.trim() ? oneOf(FECS, env.SOUNDCARD_FEC, "SOUNDCARD_FEC") : "off",
    fx25CheckBytes: env.SOUNDCARD_FX25_CHECK_BYTES?.trim()
      ? readCheckBytes(env.SOUNDCARD_FX25_CHECK_BYTES, "SOUNDCARD_FX25_CHECK_BYTES")
      : 16,
  };
  const txDelaySet = !!env.SOUNDCARD_TXDELAY_MS?.trim();
  const call = (env.SOUNDCARD_CALL || env.BOX_CALL || env.IGATE_CALL || env.DIGI_CALL || "").trim() || undefined;

  const ports: SoundcardPortSettings[] = [];
  const device = env.SOUNDCARD_DEVICE?.trim();
  if (device) {
    ports.push({
      name: "1",
      device,
      playback: env.SOUNDCARD_PLAYBACK?.trim() || device,
      rate,
      ...fields,
      tx: env.SOUNDCARD_TX === "1",
      ptt: parsePttSpec(env.SOUNDCARD_PTT),
      call,
      ...ranged,
      ...hfTxDelay(modem, txDelaySet),
    });
  }
  const extra = env.SOUNDCARD_PORTS?.trim();
  if (extra) {
    let list: unknown;
    try {
      list = JSON.parse(extra);
    } catch {
      throw new Error("SOUNDCARD_PORTS: expected a JSON array of ports");
    }
    if (!Array.isArray(list)) throw new Error("SOUNDCARD_PORTS: expected a JSON array of ports");
    list.forEach((raw, i) =>
      ports.push(extraPort(raw, ports.length + 1, i, { rate, fields, txDelaySet, call, ranged })),
    );
  }
  const names = new Set<string>();
  for (const p of ports) {
    if (names.has(p.name)) throw new Error(`SOUNDCARD_PORTS: two ports are named ${p.name}`);
    names.add(p.name);
  }
  return ports;
}

function extraPort(
  raw: unknown,
  number: number,
  index: number,
  inherit: {
    rate: number;
    fields: ModemFields;
    txDelaySet: boolean;
    call?: string;
    ranged: Record<RangedField, number>;
  },
): SoundcardPortSettings {
  const at = `SOUNDCARD_PORTS[${index}]`;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${at}: expected an object`);
  const o = raw as Record<string, unknown>;
  for (const k of Object.keys(o)) if (!FIELDS.has(k)) throw new Error(`${at}: unknown field "${k}"`);
  const str = (k: string): string | undefined => {
    const v = o[k];
    if (v === undefined || v === null || v === "") return undefined;
    if (typeof v !== "string") throw new Error(`${at}.${k}: expected text`);
    return v.trim();
  };
  const device = str("device");
  if (!device) throw new Error(`${at}.device: name the ALSA capture device, as in plughw:2,0`);
  const name = str("name") ?? String(number);
  if (!/^[\w-]{1,16}$/.test(name)) throw new Error(`${at}.name: letters, digits, - and _, up to 16`);
  const rate = o.rate === undefined ? inherit.rate : Number(o.rate);
  if (!RATES.includes(rate)) throw new Error(`${at}.rate: expected ${RATES.join(" or ")}`);
  const fields: ModemFields = {
    modem: o.modem === undefined ? inherit.fields.modem : oneOf(MODEMS, o.modem, `${at}.modem`),
    fec: o.fec === undefined ? inherit.fields.fec : oneOf(FECS, o.fec, `${at}.fec`),
    fx25CheckBytes:
      o.fx25CheckBytes === undefined
        ? inherit.fields.fx25CheckBytes
        : readCheckBytes(o.fx25CheckBytes, `${at}.fx25CheckBytes`),
  };
  const tx = o.tx === true || o.tx === 1 || o.tx === "1";
  if (o.tx !== undefined && !tx && o.tx !== false && o.tx !== 0 && o.tx !== "0")
    throw new Error(`${at}.tx: expected true or false`);
  const call = str("call") ?? inherit.call;
  if (call && !CALL_RE.test(call)) throw new Error(`${at}.call: expected a callsign such as OE8APR-10`);
  let ptt;
  try {
    ptt = parsePttSpec(str("ptt"));
  } catch (e) {
    throw new Error(`${at}.ptt: ${(e as Error).message}`, { cause: e });
  }
  const ranged = { ...inherit.ranged };
  for (const f of Object.keys(RANGES) as RangedField[]) {
    if (o[f] === undefined) continue;
    const n = Number(o[f]);
    const r = RANGES[f];
    if (typeof o[f] !== "number" || !Number.isFinite(n)) throw new Error(`${at}.${f}: expected a number`);
    ranged[f] = Math.min(r.max, Math.max(r.min, n));
    if (ranged[f] !== n)
      console.warn("[config] %s.%s=%s is outside %s–%s; using %s", at, f, n, r.min, r.max, ranged[f]);
  }
  return {
    name,
    device,
    playback: str("playback") ?? device,
    rate,
    ...fields,
    tx,
    ptt,
    call,
    ...ranged,
    ...hfTxDelay(fields.modem, inherit.txDelaySet || o.txDelayMs !== undefined),
  };
}
