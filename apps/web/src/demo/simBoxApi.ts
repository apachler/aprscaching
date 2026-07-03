// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * simBoxApi.ts — a scoped `fetch` shim that serves a canned remote-box command log for the design
 * harness, so the real `RemoteControl` surface renders populated (queued/sent/done
 * commands) with no gateway or ingest box. Install once from the harness; it only intercepts
 * `/api/box/*` and delegates everything else (including the BBS shim, if installed first) to real fetch.
 */
type BoxCmd = {
  id: number;
  callsign: string;
  kind: string;
  payload?: unknown;
  status: "queued" | "sent" | "done" | "failed";
  result?: string;
  createdAt: number;
  sentAt?: number | null;
  ackedAt?: number | null;
};

// Command timestamps are relative-rendered ("2m ago"), so anchor them to the real clock — a fixed
// epoch would read "365d ago". (Content is still deterministic; only the elapsed label varies.)
const T = Math.floor(Date.now() / 1000);
const LOG: BoxCmd[] = [
  {
    id: 5,
    callsign: "OE8APR-7",
    kind: "status",
    status: "done",
    result: "RX 24/7 · IGate on · digi on · TX off",
    createdAt: T - 40,
    sentAt: T - 39,
    ackedAt: T - 38,
  },
  {
    id: 4,
    callsign: "OE8APR-7",
    kind: "beacon",
    payload: { lat: 47.0735, lon: 15.4378, comment: "home QTH JN77rb" },
    status: "done",
    result: "beacon TX ok",
    createdAt: T - 120,
    sentAt: T - 119,
    ackedAt: T - 118,
  },
  {
    id: 3,
    callsign: "OE8APR-7",
    kind: "igate",
    payload: { on: true },
    status: "done",
    result: "IGate enabled",
    createdAt: T - 300,
    sentAt: T - 299,
    ackedAt: T - 298,
  },
  {
    id: 2,
    callsign: "OE8APR-7",
    kind: "message",
    payload: { to: "OE3ABC", text: "QRV Schoeckl 0900z, see you there 73" },
    status: "sent",
    createdAt: T - 30,
    sentAt: T - 29,
  },
  { id: 1, callsign: "OE8APR-7", kind: "digi", payload: { on: true }, status: "queued", createdAt: T - 5 },
];

const ok = (data: unknown) =>
  new Response(JSON.stringify(data), { status: 200, headers: { "content-type": "application/json" } });

/** Install the shim. Idempotent. Only `/api/box/*` is intercepted; all other requests pass through. */
export function installBoxSim(): void {
  const real = globalThis.fetch.bind(globalThis);
  if ((globalThis.fetch as { __boxSim?: boolean }).__boxSim) return;
  const shim = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const path = (() => {
      try {
        return new URL(url, location.origin).pathname;
      } catch {
        return url;
      }
    })();
    if (!path.includes("/api/box/")) return real(input, init);
    if (/\/log$/.test(path)) return ok({ boxId: "pi-home", commands: LOG });
    if (/\/command$/.test(path) && init?.method === "POST") {
      const body = (() => {
        try {
          return JSON.parse(String(init.body ?? "{}"));
        } catch {
          return {};
        }
      })();
      return ok({
        id: 99,
        boxId: "pi-home",
        kind: body.kind ?? "status",
        callsign: "OE8APR-7",
        status: "queued",
        tx: body.kind !== "status",
      });
    }
    return ok({ boxId: "pi-home", commands: LOG });
  };
  (shim as { __boxSim?: boolean }).__boxSim = true;
  globalThis.fetch = shim as typeof fetch;
}
