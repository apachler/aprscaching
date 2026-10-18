// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The public tours (`/tour/game`, `/tour/shack`): the whole app against the demo fixtures, signed in as the demo
 * cacher, so a visitor tries the real interface before joining. Nothing reaches the instance: the fixtures answer
 * its API, any other call to it goes without the visitor's cookies, and a write gets a canned "ok". Nothing stays in the visitor's browser either: local and session
 * storage live in memory for this page, and IndexedDB opens under a `tour:` name that each tour starts empty. The
 * visitor's own settings, session hint, offline packs and device key are never read or written. Only the basemap's
 * tiles come from the network, as they do in the app.
 *
 * The demo cacher's callsign is verified, so a radio connected during a tour would transmit under it: the tour keeps
 * Web Serial, Web Bluetooth and the microphone out of reach, and the app shows them as unsupported. The live socket
 * never opens either, so the visitor's own session never rides into the demo.
 */
import type { TourName } from "../deeplink.js";
import { apiOrigin } from "../api.js";
import { installAppFixtures } from "./fixtures.js";

/** A Storage that forgets everything when the page goes. */
class MemoryStorage implements Storage {
  private items = new Map<string, string>();
  get length(): number {
    return this.items.size;
  }
  clear(): void {
    this.items.clear();
  }
  getItem(key: string): string | null {
    return this.items.get(String(key)) ?? null;
  }
  key(index: number): string | null {
    return [...this.items.keys()][index] ?? null;
  }
  removeItem(key: string): void {
    this.items.delete(String(key));
  }
  setItem(key: string, value: string): void {
    this.items.set(String(key), String(value));
  }
}

const PREFIX = "tour:";

/** IndexedDB under the `tour:` names, each emptied the first time this page opens it. */
function tourIndexedDB(real: IDBFactory): IDBFactory {
  const fresh = new Set<string>();
  return {
    open(name: string, version?: number) {
      const tourName = PREFIX + name;
      // requests on one name run in order, so the delete lands before this page's first open
      if (!fresh.has(tourName)) {
        fresh.add(tourName);
        real.deleteDatabase(tourName);
      }
      return version === undefined ? real.open(tourName) : real.open(tourName, version);
    },
    deleteDatabase: (name: string) => real.deleteDatabase(PREFIX + name),
    cmp: (a: unknown, b: unknown) => real.cmp(a, b),
    databases: async () => [],
  };
}

function isolateStorage(): void {
  const local = new MemoryStorage();
  const session = new MemoryStorage();
  Object.defineProperty(window, "localStorage", { configurable: true, get: () => local });
  Object.defineProperty(window, "sessionStorage", { configurable: true, get: () => session });
  if (window.indexedDB) {
    const idb = tourIndexedDB(window.indexedDB);
    Object.defineProperty(window, "indexedDB", { configurable: true, get: () => idb });
  }
}

/** No serial port, no Bluetooth, no microphone or line-in: the app's support checks report them missing. */
function keepRadiosAway(): void {
  for (const api of ["serial", "bluetooth", "mediaDevices"]) {
    Object.defineProperty(navigator, api, { configurable: true, get: () => undefined });
  }
}

/** A live socket that stays connecting: no frames in, none out, and nothing for the client to retry. */
class SilentSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;
  readyState = 0;
  binaryType: BinaryType = "blob";
  bufferedAmount = 0;
  extensions = "";
  protocol = "";
  onopen: ((ev: Event) => unknown) | null = null;
  onmessage: ((ev: MessageEvent) => unknown) | null = null;
  onerror: ((ev: Event) => unknown) | null = null;
  onclose: ((ev: CloseEvent) => unknown) | null = null;
  constructor(readonly url: string) {
    super();
  }
  send(): void {}
  close(): void {}
}

/**
 * Underneath the fixtures: a call to the instance they do not answer goes without the visitor's cookies, and a write
 * never leaves the browser. The instance is the page's origin and the gateway's, which `VITE_API_BASE` may put on
 * another host that still takes the visitor's session cookie.
 */
function keepWritesLocal(): void {
  const real = window.fetch.bind(window);
  const gateway = apiOrigin();
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    const origin = new URL(req.url, location.href).origin;
    if (origin !== location.origin && origin !== gateway) return real(req);
    if (req.method !== "GET" && req.method !== "HEAD") return Response.json({ ok: true });
    return real(new Request(req, { credentials: "omit" }));
  };
}

/** Where each tour opens: the game on a cache someone else hid (so it can be logged), the Shack on its launcher. */
const START: Record<TourName, string> = { game: "?cache=AC0005", shack: "?view=shack" };

/** Turn this page into a tour, before the app reads its address or its storage. */
export function enterTour(tour: TourName): void {
  isolateStorage();
  keepRadiosAway();
  Object.defineProperty(window, "WebSocket", { configurable: true, writable: true, value: SilentSocket });
  keepWritesLocal();
  installAppFixtures("user", true);
  history.replaceState(null, "", `/tour/${tour}${START[tour]}${location.hash}`);
}
