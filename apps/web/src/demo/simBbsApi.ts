// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * simBbsApi.ts — a scoped `fetch` shim that serves canned BBS data for the design harness, so the real
 * `BbsPanel` renders populated (inbox / sent / bulletins / thread) with no gateway or DB. Install once
 * from the harness entry; it only intercepts `/api/bbs/*` and delegates everything else to real fetch.
 */
type Msg = {
  id: number; bid: string; type: "P" | "B" | "T"; fromCall: string; toCall: string;
  subject: string | null; body: string; postedAt: number; origin: string; readAt: number | null;
  replyTo: number | null; threadId: number | null; delivery?: string;
};

const T = 1751350800; // fixed epoch (harness determinism)
const m = (o: Partial<Msg> & Pick<Msg, "id" | "type" | "fromCall" | "toCall" | "body">): Msg => ({
  bid: `${o.id}_oe.sim`, subject: null, postedAt: T, origin: "local", readAt: null, replyTo: null, threadId: o.id, ...o,
});

const INBOX: Msg[] = [
  m({ id: 1, type: "P", fromCall: "OE3ABC", toCall: "OE8APR-7", subject: "Re: JN77 activation Sat", body: "Great, I'll bring the 2m beam and the DigiRig. Meet at the Schoeckl car park 0900z? 73 Martin OE3ABC", delivery: "held" }),
  m({ id: 2, type: "P", fromCall: "DL2XYZ", toCall: "OE8APR-7", subject: "QSL via bureau OK", body: "Confirmed our 20m SSB QSO from last Sunday. Card on its way via the DARC bureau. 73!", delivery: "held" }),
  m({ id: 3, type: "P", fromCall: "OE5FLM", toCall: "OE8APR-7", subject: "Found AC-0008 Schoeckl", body: "Logged your living cache on the summit today - beaconed from the TH-D75. Nice hide! vy 73", readAt: T, delivery: "acked" }),
  m({ id: 4, type: "P", fromCall: "OE3ABC", toCall: "OE8APR-7", subject: "Re: JN77 activation Sat", body: "One more thing - I'll also bring the mast clamp and a spare coax. See you Sat! 73", replyTo: 10, threadId: 1, postedAt: T + 3600 }),
  m({ id: 6, type: "P", fromCall: "OE5FLM", toCall: "OE8APR-7", subject: "Re: JN77 activation Sat", body: "Mind if I join for the activation? I can bring a second HT and log. 73 Franz", replyTo: 1, threadId: 1, postedAt: T + 5400 }),
];
const SENT: Msg[] = [
  m({ id: 10, type: "P", fromCall: "OE8APR-7", toCall: "OE3ABC", subject: "Re: JN77 activation Sat", body: "Perfect - car park 0900z it is. I'll bring coffee and the spare LiFePO4. 73 Andreas", replyTo: 1, threadId: 1, postedAt: T + 1800, delivery: "sent" }),
];
const BULLETINS: Msg[] = [
  m({ id: 20, type: "B", fromCall: "OE8XBM-7", toCall: "ALL", subject: "Graz packet net Tue 19:00", body: "Weekly Steiermark packet net every Tuesday 19:00 local on 144.800 MHz. All welcome - connect OE8XBM-7." }),
  m({ id: 21, type: "B", fromCall: "OE1SGW", toCall: "SOTA", subject: "SOTA OE/ST-027 Schoeckl Sat", body: "Activating Schoeckl this Saturday from 0900z. 2m FM + 20m CW. Chasers welcome, spot me on the cluster." }),
  m({ id: 22, type: "B", fromCall: "DL2XYZ", toCall: "SALE", subject: "FS: Kenwood TH-D75 as new", body: "For sale: Kenwood TH-D75E, boxed, 2 months old, APRS + D-STAR. EUR 590 + shipping. Reply via packet or email.", origin: "db0abc.deu.eu" }),
  m({ id: 23, type: "B", fromCall: "OE3ABC", toCall: "WANTED", subject: "WTB: DigiRig or NinoTNC", body: "Looking for a DigiRig Mobile or a NinoTNC N9600A4 for a portable digipeater build. Anyone in OE3? 73 Martin" }),
  m({ id: 24, type: "B", fromCall: "OK1DX", toCall: "DX", subject: "3Y0J Bouvet QRV 20m", body: "3Y0J spotted 14.023 CW up 2, strong into central EU around 1800z. Good luck all - rare one!", origin: "ok0nag.cze.eu" }),
];

const ok = (data: unknown) => new Response(JSON.stringify(data), { status: 200, headers: { "content-type": "application/json" } });

/** Install the shim. Idempotent. Only `/api/bbs/*` is intercepted; all other requests pass through. */
export function installBbsSim(): void {
  const real = globalThis.fetch.bind(globalThis);
  if ((globalThis.fetch as { __bbsSim?: boolean }).__bbsSim) return;
  const shim = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const path = (() => { try { return new URL(url, location.origin).pathname; } catch { return url; } })();
    if (!path.includes("/api/bbs/")) return real(input, init);
    if (path.endsWith("/api/bbs/messages") && (!init || (init.method ?? "GET") === "GET")) return ok({ messages: INBOX });
    if (path.endsWith("/api/bbs/sent")) return ok({ messages: SENT });
    if (path.endsWith("/api/bbs/bulletins")) return ok({ bulletins: BULLETINS });
    const thread = /\/api\/bbs\/thread\/(\d+)$/.exec(path);
    if (thread) { const id = Number(thread[1]); return ok({ messages: [...INBOX, ...SENT].filter((x) => x.threadId === id || x.id === id) }); }
    if (path.endsWith("/api/bbs/messages") && init?.method === "POST") return ok({ ok: true, id: 99, bid: "99_oe.sim", type: "P", threadId: 99 });
    if (/\/read$/.test(path)) return ok({ ok: true });
    return ok({ messages: [] });
  };
  (shim as { __bbsSim?: boolean }).__bbsSim = true;
  globalThis.fetch = shim as typeof fetch;
}
