// SPDX-License-Identifier: AGPL-3.0-or-later
// The read API's heard feed: a station's latest hearing as a cacheable snapshot with a `since` cursor and an
// ETag, and as a Server-Sent Events stream that pushes each packet of a watched call the moment an ingest batch
// is dispatched, from the live rooms' memory. Streams per client are bounded, and nothing account-side leaves.
import { describe, it, expect } from "vitest";
import { RoomsCore } from "@aprscaching/gateway/rooms-core";
import { HEARD_STREAM_MAX_OPEN } from "@aprscaching/shared";
import { authEnv, call, ORIGIN } from "./helpers/authflow.js";
import { serve } from "./helpers/fedpeer.js";
import { roomNamespace } from "../src/host.js";

const SECRET = { "x-ingest-secret": "test-ingest-secret" };
const now = () => Math.floor(Date.now() / 1000);
const envWithRooms = (extra: Record<string, unknown> = {}) =>
  authEnv({ ROOMS: roomNamespace(new RoomsCore({ heartbeatMs: 0 })), ...extra });

const pkt = (src: string, payload: string, heardVia = "rf", ts = now()) => ({
  src,
  dst: "APRS",
  path: heardVia === "rf" ? ["WIDE1-1"] : ["TCPIP*", "qAC", "T2TEST"],
  payload,
  heardVia,
  port: heardVia === "rf" ? "kiss-tnc" : "aprs-is",
  ts,
});
const POS = "!4703.00N/01525.00E>On the road";

/** Read a stream until `want` matches what has arrived, or fail after two seconds. */
async function readUntil(reader: ReadableStreamDefaultReader<Uint8Array>, got: { text: string }, want: RegExp) {
  const dec = new TextDecoder();
  const deadline = Date.now() + 2000;
  while (!want.test(got.text)) {
    const left = deadline - Date.now();
    if (left <= 0) throw new Error(`timed out waiting for ${want}; got: ${got.text}`);
    const r = await Promise.race([reader.read(), new Promise<null>((res) => setTimeout(() => res(null), left))]);
    if (!r) continue;
    if (r.done) throw new Error(`stream ended; got: ${got.text}`);
    got.text += dec.decode(r.value, { stream: true });
  }
}

const openStream = (env: ReturnType<typeof envWithRooms>, query: string, headers: Record<string, string> = {}) =>
  serve(env)(
    new Request(`${ORIGIN}/api/v1/stations/heard/stream?${query}`, {
      headers: { "x-real-ip": "198.51.100.7", ...headers },
    }),
  );

describe("GET /api/v1/station/:call/heard", () => {
  it("answers the latest hearing: time, route, position, comment and status text, and no account data", async () => {
    const env = envWithRooms();
    // the station sits in an account's registry: neither the account nor the registry entry leaves
    await env.DB.prepare(
      `INSERT INTO account_stations (account_id, callsign, description, roles, created_at, updated_at)
       VALUES ('acct-secret-id', 'OE8HRD-9', 'a private note', 'igate', 1, 1)`,
    ).run();
    const t = now() - 60;
    const batch = [pkt("OE8HRD-9", POS, "rf", t - 30), pkt("OE8HRD-9", ">Hiking the ridge", "aprs_is", t)];
    expect((await call(env, "POST", "/ingest", { packets: batch }, SECRET)).status).toBe(200);

    const res = await call(env, "GET", "/api/v1/station/oe8hrd-9/heard");
    expect(res.status).toBe(200);
    expect(res.data).toMatchObject({
      callsign: "OE8HRD-9",
      lastHeard: t,
      via: "aprs_is",
      path: ["TCPIP*", "qAC", "T2TEST"],
      position: { lat: 47.05, lon: 15.416667, symbol: "/>", ts: t - 30 },
      comment: "On the road",
      status: { text: "Hiking the ridge", ts: t },
      cursor: t,
      changed: true,
    });
    const text = JSON.stringify(res.data);
    for (const leak of ["owner", "account", "registered", "acct-secret-id", "roles", "a private note"])
      expect(text).not.toContain(leak);
  });

  it("is cacheable, says whether anything was heard after a cursor, and answers 304 to its own ETag", async () => {
    const env = envWithRooms();
    const t = now() - 60;
    await call(env, "POST", "/ingest", { packets: [pkt("OE8CUR", POS, "rf", t)] }, SECRET);
    const url = `${ORIGIN}/api/v1/station/OE8CUR/heard`;
    const first = await serve(env)(new Request(url));
    expect(first.headers.get("cache-control")).toBe("public, max-age=15");
    const etag = first.headers.get("etag")!;
    expect(etag).toBe(`W/"heard-OE8CUR-${t}"`);
    expect((await first.json()) as { cursor: number }).toMatchObject({ cursor: t, changed: true });
    expect(((await (await serve(env)(new Request(`${url}?since=${t}`))).json()) as { changed: boolean }).changed).toBe(
      false,
    );
    expect((await serve(env)(new Request(url, { headers: { "if-none-match": etag } }))).status).toBe(304);

    await call(env, "POST", "/ingest", { packets: [pkt("OE8CUR", ">Back home", "rf", t + 30)] }, SECRET);
    const later = await serve(env)(new Request(`${url}?since=${t}`, { headers: { "if-none-match": etag } }));
    expect(later.status).toBe(200);
    expect(await later.json()).toMatchObject({ changed: true, cursor: t + 30, status: { text: "Back home" } });
  });

  it("answers an unheard station with nothing heard, and refuses what is no callsign or cursor", async () => {
    const env = envWithRooms();
    const res = await call(env, "GET", "/api/v1/station/OE8NONE/heard");
    expect(res.data).toMatchObject({ lastHeard: null, position: null, status: null, cursor: 0, changed: true });
    expect((await call(env, "GET", "/api/v1/station/TOO-LONG-SSID/heard")).status).toBe(400);
    expect((await call(env, "GET", "/api/v1/station/OE8NONE/heard?since=soon")).status).toBe(400);
  });

  it("counts against the read API's rate limit and is listed in its index", async () => {
    const env = envWithRooms({ API_RATE_ANON: "1" });
    const ip = "198.51.100.41";
    expect((await call(env, "GET", "/api/v1/station/OE8RL/heard", undefined, {}, ip)).status).toBe(200);
    expect((await call(env, "GET", "/api/v1/station/OE8RL/heard", undefined, {}, ip)).status).toBe(429);
    const index = await call(env, "GET", "/api/v1", undefined, {}, "198.51.100.42");
    const paths = (index.data.endpoints as { path: string }[]).map((e) => e.path);
    expect(paths).toContain("/api/v1/station/:call/heard?since=");
    expect(paths).toContain("/api/v1/stations/heard/stream?calls=CALL1,CALL2");
  });
});

describe("GET /api/v1/stations/heard/stream", () => {
  it("opens with a snapshot per call, then pushes each watched packet an ingest batch carries", async () => {
    const env = envWithRooms();
    const res = await openStream(env, "calls=OE8STR,DL1OTH-5");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const reader = res.body!.getReader();
    const got = { text: "" };
    await readUntil(reader, got, /retry: \d+[\s\S]*event: snapshot[\s\S]*OE8STR[\s\S]*event: snapshot[\s\S]*DL1OTH-5/);

    const t = now();
    const batch = [
      pkt("OE8STR-7", POS, "rf", t), // an SSID of a watched base call
      pkt("OE9NOT", POS, "rf", t), // not watched
      pkt("DL1OTH-5", ">QRV on 2 m", "aprs_is", t),
      pkt("DL1OTH-5", ">QRV on 2 m", "aprs_is", t), // a duplicate copy: no second event
    ];
    expect((await call(env, "POST", "/ingest", { packets: batch }, SECRET)).status).toBe(200);
    await readUntil(reader, got, /event: heard[\s\S]*OE8STR-7[\s\S]*event: heard[\s\S]*DL1OTH-5/);
    const events = got.text
      .split("\n\n")
      .filter((f) => f.startsWith("event: heard"))
      .map((f) => JSON.parse(/data: (.*)/.exec(f)![1]!) as Record<string, unknown>);
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ type: "heard", callsign: "OE8STR-7", via: "rf", position: { lat: 47.05 } });
    expect(events[1]).toMatchObject({ callsign: "DL1OTH-5", via: "aprs_is", status: "QRV on 2 m" });
    expect(got.text).not.toContain("OE9NOT");
    await reader.cancel();
  });

  it("bounds the streams one client holds open, and frees a slot when one closes", async () => {
    const env = envWithRooms();
    const open = [];
    for (let i = 0; i < HEARD_STREAM_MAX_OPEN.anonymous; i++) {
      const r = await openStream(env, "calls=OE8LIM");
      expect(r.status).toBe(200);
      open.push(r.body!.getReader());
    }
    const over = await openStream(env, "calls=OE8LIM");
    expect(over.status).toBe(429);
    expect(((await over.json()) as { error: string }).error).toMatch(/free key/);
    // another client is not counted against this one
    expect((await openStream(env, "calls=OE8LIM", { "x-real-ip": "198.51.100.8" })).status).toBe(200);
    await open[0]!.cancel();
    expect((await openStream(env, "calls=OE8LIM")).status).toBe(200);
  });

  it("refuses a missing or too long calls list, and answers 503 where no live rooms run", async () => {
    const env = envWithRooms();
    expect((await openStream(env, "")).status).toBe(400);
    const many = Array.from({ length: 21 }, (_, i) => `OE8A${i}`).join(",");
    expect((await openStream(env, `calls=${many}`)).status).toBe(400);
    const bare = authEnv({ ROOMS: { get: () => ({ fetch: async () => new Response(null, { status: 204 }) }) } });
    expect((await openStream(bare as ReturnType<typeof envWithRooms>, "calls=OE8APR")).status).toBe(503);
  });
});
