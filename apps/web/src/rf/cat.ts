// SPDX-License-Identifier: AGPL-3.0-or-later
import { useSyncExternalStore } from "react";
import { catSetFrequency, catSetMode, type CatRig } from "@aprsweb/aprs";

/**
 * cat.ts — browser-direct CAT rig control over Web Serial (docs/16 H6). A single shared controller so
 * any surface (the Workbench rig panel, a spot card) can one-click tune the connected radio. Tuning
 * is RX-side (set VFO frequency/mode) — not transmitting — so it is NOT H5-gated. Chromium-only.
 */
export interface RigProfile { rig: CatRig; baud: number; icomAddr: number }

interface SerialPortLike {
  writable: WritableStream<Uint8Array> | null;
  open(options: { baudRate: number }): Promise<void>;
  close(): Promise<void>;
}

export const catSupported = (): boolean =>
  typeof navigator !== "undefined" && typeof (navigator as { serial?: { requestPort?: unknown } }).serial?.requestPort === "function";

class CatController {
  private port: SerialPortLike | null = null;
  profile: RigProfile | null = null;
  private listeners = new Set<() => void>();

  get connected(): boolean { return !!this.port; }
  subscribe = (l: () => void): (() => void) => { this.listeners.add(l); return () => this.listeners.delete(l); };
  private emit() { for (const l of this.listeners) l(); }

  async connect(profile: RigProfile): Promise<void> {
    const serial = (navigator as unknown as { serial: { requestPort(): Promise<SerialPortLike> } }).serial;
    const port = await serial.requestPort();
    await port.open({ baudRate: profile.baud });
    this.port = port; this.profile = profile; this.emit();
  }

  async disconnect(): Promise<void> {
    try { await this.port?.close(); } catch { /* */ }
    this.port = null; this.emit();
  }

  /** Tune the rig to `hz`, and optionally set the mode (best-effort). Throws if not connected. */
  async tune(hz: number, mode?: string | null): Promise<void> {
    if (!this.port?.writable || !this.profile) throw new Error("No rig connected");
    const opts = { icomAddr: this.profile.icomAddr };
    const w = this.port.writable.getWriter();
    try {
      await w.write(catSetFrequency(this.profile.rig, hz, opts));
      if (mode) { const mb = catSetMode(this.profile.rig, mode, opts); if (mb) await w.write(mb); }
    } finally { w.releaseLock(); }
  }
}

export const cat = new CatController();

/** Re-render a component when the rig connection state changes. */
export function useCatConnected(): boolean {
  return useSyncExternalStore(cat.subscribe, () => cat.connected, () => false);
}
