// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The push-to-talk interface every keying driver implements. A driver only switches the transmitter; whether
 * a transmission may happen at all is decided before `key()` is called, by the soundcard port's transmit gate.
 * Every driver drives its line to the unkeyed level as it opens.
 */
export interface Ptt {
  /** What keys the radio, for logs and the doctor (`CM108 /dev/hidraw0 GPIO3`). */
  readonly label: string;
  key(): Promise<void>;
  unkey(): Promise<void>;
  /** Unkey and release the device. */
  close(): Promise<void>;
  /**
   * Unkey without waiting, for process exit, where no asynchronous work runs any more. Best effort: a driver
   * that has no synchronous path (rigctld over TCP) leaves it out.
   */
  releaseSync?(): void;
}

/** A parsed `SOUNDCARD_PTT` value. */
export type PttSpec =
  | { kind: "none" }
  | { kind: "serial"; path: string; line: "rts" | "dtr" }
  | { kind: "cat"; path: string; rig: "kenwood" | "icom" | "yaesu-bin"; baud: number; icomAddr?: number }
  | { kind: "rigctld"; host: string; port: number }
  | { kind: "cm108"; path: string; gpio: number }
  | { kind: "gpio"; chip: string; line: number; invert: boolean }
  | {
      kind: "termux-usb";
      /** The usbfs path termux-usb names (`/dev/bus/usb/001/002`), or `auto` for the only device attached. */
      device: string;
      /** The keying line (termuxusb.ts), or `auto` to choose it by the device's VID:PID. */
      method: UsbPttMethod | "auto";
      /** The CM108 GPIO that keys, 1–8. */
      gpio: number;
      /** The helper's own watchdog, a backstop behind the port's (`SOUNDCARD_PTT_MAX_MS` plus a margin). */
      maxKeyMs?: number;
    };

/** The keying lines the USB PTT helper drives (deploy/pocket/extras/usb_ptt.py). */
export const USB_PTT_METHODS = [
  "cdc-dtr",
  "cdc-rts",
  "cp210x-rts",
  "cp210x-dtr",
  "ftdi-rts",
  "ftdi-dtr",
  "ch340-rts",
  "ch340-dtr",
  "cm108",
] as const;
export type UsbPttMethod = (typeof USB_PTT_METHODS)[number];
