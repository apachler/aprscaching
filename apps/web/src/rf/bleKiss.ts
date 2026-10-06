// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * bleKiss.ts — the KISS byte link over Web Bluetooth, shared by My radio (rf/kiss.ts) and the packet
 * terminal (packet/bleKiss.ts). It moves raw KISS bytes only: notifications arrive in whatever pieces the TNC
 * sends, so a caller feeds them to a streaming KissDecoder, which reassembles a frame split across
 * notifications and splits several frames sharing one. Writes go out in 20-byte pieces, one at a time.
 *
 * Two GATT services carry KISS over BLE, and a TNC offers one of them:
 * - The BLE KISS API service (Mobilinkd TNC3/TNC4, aprs.fi, many LoRa APRS trackers). UUIDs from Mobilinkd's
 *   own sources: github.com/mobilinkd/iosTncConfig "Mobilinkd TNC Config/UUIDKey.swift" and
 *   the protocol notes (PROTOCOL.md) in github.com/mobilinkd/webconfig, and the shared specification
 *   github.com/hessu/aprs-specs BLE-KISS-API.md.
 * - The Nordic UART Service, the generic serial-over-BLE service other TNCs and bridges use.
 *
 * Chromium-only and session-bound; callers feature-detect with webBluetoothSupported(). Transmit is gated on
 * callsign control-verification by the caller; this link only carries the bytes it is handed.
 */

/** One GATT service that carries KISS: notifications bring device → host bytes, writes carry host → device. */
interface BleKissProfile {
  name: string;
  service: string;
  /** device → host, notify */
  notify: string;
  /** host → device, write */
  write: string;
}

export const BLE_KISS_API: BleKissProfile = {
  name: "BLE KISS",
  service: "00000001-ba2a-46c9-ae49-01b0961f68bb",
  notify: "00000003-ba2a-46c9-ae49-01b0961f68bb",
  write: "00000002-ba2a-46c9-ae49-01b0961f68bb",
};

export const NORDIC_UART: BleKissProfile = {
  name: "Nordic UART",
  service: "6e400001-b5a3-f393-e0a9-e50e24dcca9e",
  notify: "6e400003-b5a3-f393-e0a9-e50e24dcca9e",
  write: "6e400002-b5a3-f393-e0a9-e50e24dcca9e",
};

/** Every profile, in order of preference when a device offers more than one. */
const BLE_KISS_PROFILES: readonly BleKissProfile[] = [BLE_KISS_API, NORDIC_UART];

/** A write fits the default ATT MTU (23 bytes less the 3-byte header); Web Bluetooth does not report a larger one. */
const BLE_CHUNK = 20;

/** Is a Bluetooth TNC reachable here? (Web Bluetooth — Chromium on desktop or Android, secure context.) */
export const webBluetoothSupported = (): boolean =>
  typeof navigator !== "undefined" &&
  typeof (navigator as { bluetooth?: { requestDevice?: unknown } }).bluetooth?.requestDevice === "function";

/** The requestDevice options: the chooser lists a device offering either service, and both stay reachable. */
export function bleKissRequestOptions(): {
  filters: { services: string[] }[];
  optionalServices: string[];
} {
  return {
    filters: BLE_KISS_PROFILES.map((p) => ({ services: [p.service] })),
    optionalServices: BLE_KISS_PROFILES.map((p) => p.service),
  };
}

/** The profile to use for the services a device offers (UUIDs in any case), or null when it offers neither. */
export function pickBleKissProfile(offered: readonly string[]): BleKissProfile | null {
  const have = new Set(offered.map((u) => u.toLowerCase()));
  return BLE_KISS_PROFILES.find((p) => have.has(p.service)) ?? null;
}

/** Split bytes into writes of at most `size` bytes, in order. */
export function bleChunks(bytes: Uint8Array, size = BLE_CHUNK): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let i = 0; i < bytes.length; i += size) out.push(bytes.subarray(i, i + size));
  return out;
}

/** The bytes of a notification's value — only its own window of a possibly shared buffer. */
export const viewBytes = (v: DataView): Uint8Array => new Uint8Array(v.buffer, v.byteOffset, v.byteLength);

/** How a write reaches the TNC: without a response when the characteristic allows it, the faster path. */
export function bleWriteMode(
  props: { writeWithoutResponse?: boolean } | undefined,
): "without-response" | "with-response" {
  return props?.writeWithoutResponse ? "without-response" : "with-response";
}

/**
 * A KISS byte link to a Bluetooth TNC. connect() prompts for a device (needs a user gesture), picks the
 * service it offers and subscribes to its notifications; write() queues bytes so the pieces of two frames
 * never interleave and no two GATT writes overlap.
 */
export class BleKissLink {
  private device: BleDeviceLike | null = null;
  private notifyChar: BleCharLike | null = null;
  private writeChar: BleCharLike | null = null;
  private queue: Promise<void> = Promise.resolve();
  private closed = false;
  /** The service in use once connected. */
  profile: BleKissProfile | null = null;
  private readonly onValue = (ev: Event) => {
    const v = (ev.target as { value?: DataView }).value;
    if (v) this.onBytes(viewBytes(v));
  };

  constructor(
    private onBytes: (chunk: Uint8Array) => void,
    private onLost?: () => void,
  ) {}

  /** Throws when no link comes up, with the GATT connection already released; onLost is for an established link. */
  async connect(): Promise<void> {
    const bt = (navigator as unknown as { bluetooth: { requestDevice(o: unknown): Promise<BleDeviceLike> } }).bluetooth;
    const device = await bt.requestDevice(bleKissRequestOptions());
    this.device = device;
    // The link counts as lost only once it is up: a GATT drop while connecting is connect()'s own error.
    this.closed = true;
    device.addEventListener?.("gattserverdisconnected", () => {
      if (!this.closed && this.device === device) this.onLost?.();
    });
    try {
      const gatt = await device.gatt.connect();
      const services = await gatt.getPrimaryServices();
      const profile = pickBleKissProfile(services.map((s) => s.uuid));
      const svc = profile && services.find((s) => s.uuid.toLowerCase() === profile.service);
      if (!profile || !svc) throw new Error("this Bluetooth device offers no KISS service");
      this.profile = profile;
      this.notifyChar = await svc.getCharacteristic(profile.notify);
      this.notifyChar.addEventListener("characteristicvaluechanged", this.onValue);
      await this.notifyChar.startNotifications();
      try {
        this.writeChar = await svc.getCharacteristic(profile.write);
      } catch {
        this.writeChar = null; // a receive-only TNC
      }
    } catch (e) {
      await this.disconnect(); // a half-set-up link must not hold the GATT connection open
      throw e;
    }
    this.closed = false;
  }

  /** Can this TNC transmit? (It offers the write characteristic.) */
  get writable(): boolean {
    return this.writeChar != null;
  }

  /** Queue bytes for the TNC in 20-byte writes; resolves once they are written. Throws on a receive-only TNC. */
  write(bytes: Uint8Array): Promise<void> {
    const ch = this.writeChar;
    if (!ch) return Promise.reject(new Error("this TNC has no writable TX characteristic"));
    const mode = bleWriteMode(ch.properties);
    const run = async () => {
      for (const piece of bleChunks(bytes)) {
        if (mode === "without-response" && ch.writeValueWithoutResponse) await ch.writeValueWithoutResponse(piece);
        else if (ch.writeValueWithResponse) await ch.writeValueWithResponse(piece);
        else await ch.writeValue!(piece);
      }
    };
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => {}); // one failed write must not block the next
    return next;
  }

  async disconnect(): Promise<void> {
    this.closed = true;
    try {
      this.notifyChar?.removeEventListener("characteristicvaluechanged", this.onValue);
    } catch {
      /* already gone */
    }
    try {
      await this.notifyChar?.stopNotifications();
    } catch {
      /* already stopped */
    }
    try {
      this.device?.gatt.disconnect();
    } catch {
      /* already disconnected */
    }
    this.device = null;
    this.notifyChar = null;
    this.writeChar = null;
    this.profile = null;
  }
}

/** Minimal slices of the Web Bluetooth API this link uses (avoids an extra @types dependency). */
interface BleCharLike {
  properties?: { writeWithoutResponse?: boolean; write?: boolean };
  startNotifications(): Promise<unknown>;
  stopNotifications(): Promise<unknown>;
  addEventListener(t: string, fn: (e: Event) => void): void;
  removeEventListener(t: string, fn: (e: Event) => void): void;
  writeValueWithoutResponse?(data: Uint8Array): Promise<void>;
  writeValueWithResponse?(data: Uint8Array): Promise<void>;
  writeValue?(data: Uint8Array): Promise<void>;
}
interface BleServiceLike {
  uuid: string;
  getCharacteristic(u: string): Promise<BleCharLike>;
}
interface BleDeviceLike {
  gatt: {
    connect(): Promise<{ getPrimaryServices(): Promise<BleServiceLike[]> }>;
    disconnect(): void;
  };
  addEventListener?(t: string, fn: () => void): void;
}
