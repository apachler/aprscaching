/**
 * fieldStation.ts — the off-grid "field station" client store (docs/16 A + D). A radio + browser is a
 * self-contained APRS station: decoded RF frames become live stations + a local inbox, entirely in-memory,
 * independent of any gateway. The same decoded `RfFrame` that feeds the forward-to-gateway path feeds this
 * local view. It also queues locally-heard raw frames so they can replay ("sync-back") when connectivity
 * returns. Pure classification lives in `@aprsweb/aprs` (`localEvent`); this is just the bounded store.
 */
import { localEvent, type LocalStation, type LocalMessage } from "@aprsweb/aprs";
import type { Packet } from "@aprsweb/shared";
import type { RfFrame } from "./kiss.js";

const STA_TTL_MS = 60 * 60 * 1000;   // drop a station not heard for an hour
const MSG_CAP = 200;
const HEARD_CAP = 500;

type Snapshot = { stations: LocalStation[]; messages: LocalMessage[]; heard: number };

class FieldStation {
  private stations = new Map<string, LocalStation>();
  private messages: LocalMessage[] = [];
  private heard: { raw: string; at: number; packet: Packet }[] = [];   // for sync-back (D)
  private subs = new Set<() => void>();

  /** Feed a decoded RF frame: update the live station or append to the inbox; queue it for sync-back. */
  feed(f: RfFrame): void {
    const ev = localEvent(f.frame, f.data, f.at);
    if (ev.kind === "station") this.stations.set(ev.station.callsign, ev.station);
    else if (ev.kind === "message") this.messages = [ev.message, ...this.messages].slice(0, MSG_CAP);
    if (f.frame.raw) { this.heard.push({ raw: f.frame.raw, at: f.at, packet: f.packet }); if (this.heard.length > HEARD_CAP) this.heard.shift(); }
    if (ev.kind !== "none") this.emit();
  }

  /** Current live stations (TTL-pruned), most-recently-heard first. */
  liveStations(now = Date.now()): LocalStation[] {
    const out: LocalStation[] = [];
    for (const [call, s] of this.stations) {
      if (now - s.heardAt > STA_TTL_MS) this.stations.delete(call);
      else out.push(s);
    }
    return out.sort((a, b) => b.heardAt - a.heardAt);
  }
  inbox(): LocalMessage[] { return this.messages; }
  heardForSync(): { raw: string; at: number; packet: Packet }[] { return this.heard; }
  clearHeard(): void { this.heard = []; }

  snapshot(): Snapshot { return { stations: this.liveStations(), messages: this.messages, heard: this.heard.length }; }
  subscribe(fn: () => void): () => void { this.subs.add(fn); return () => this.subs.delete(fn); }
  private emit(): void { for (const fn of this.subs) try { fn(); } catch { /* ignore */ } }
}

/** The one shared field-station store (a module singleton, like the tool host). */
export const fieldStation = new FieldStation();
