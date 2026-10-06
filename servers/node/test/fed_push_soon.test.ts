// SPDX-License-Identifier: AGPL-3.0-or-later
// A spoke pushes promptly and completely: every feed the pull serves goes to the hub, and a local write
// is pushed a few seconds later, a burst of writes in one cycle, while a hub known to be down is left to
// the catch-up probe.
import { describe, it, expect, afterEach, vi } from "vitest";
import { PUSH_SOON_DELAY_MS, PUSH_SOON_MAX_WAIT_MS, pushSoon, pushToHub } from "@aprscaching/gateway/fedpush";
import { addCache, instanceEnv, newFedKey, serve, stubFetch } from "./helpers/fedpeer.js";
import type { Env } from "@aprscaching/gateway/env";

const SECRET = "submit-secret";
const HUB = "https://hub.example";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function pair() {
  const hub = instanceEnv("hub.example", await newFedKey(), { FED_SUBMIT_SECRET: SECRET });
  const spoke = instanceEnv("s.example", await newFedKey(), { FED_HUB_URL: HUB, FED_SUBMIT_SECRET: SECRET });
  const submits: string[] = [];
  stubFetch({
    [HUB]: async (req) => {
      if (new URL(req.url).pathname === "/federation/submit") submits.push(req.url);
      return serve(hub)(req);
    },
  });
  return { hub, spoke, submits };
}

const marks = async (hub: Env) =>
  (
    await hub.DB.prepare("SELECT type FROM fed_submit_marks WHERE instance = 's.example' ORDER BY type").all<{
      type: string;
    }>()
  ).results.map((r) => r.type);

describe("what a spoke pushes", () => {
  it("carries bulletins and account moves to the hub", async () => {
    const t = await pair();
    await addCache(t.spoke);
    await t.spoke.DB.prepare(
      "INSERT INTO bbs_messages (type, from_call, to_call, subject, body, posted_at, origin) VALUES ('B', 'OE8APR', 'ALL', 'Net tonight', 'On 145.500 at 19:00', ?, 'local')",
    )
      .bind(Math.floor(Date.now() / 1000))
      .run();
    await t.spoke.DB.prepare(
      "INSERT INTO account_moves (callsign, from_instance, to_instance, ts) VALUES ('OE8MOV', 'old.example', 's.example', ?)",
    )
      .bind(Math.floor(Date.now() / 1000))
      .run();
    const r = await pushToHub(t.spoke);
    expect(r?.failure).toBeUndefined();
    expect(await marks(t.hub)).toEqual(["account-move", "bulletin", "cache"]);
    const mirrored = await t.hub.DB.prepare(
      "SELECT subject FROM bbs_messages WHERE origin = 's.example' AND type = 'B'",
    ).first<{ subject: string }>();
    expect(mirrored?.subject).toBe("Net tonight");
    // the hub's marks name each feed as the spoke does, so a resync resumes instead of starting over
    const before = t.submits.length;
    expect((await pushToHub(t.spoke, undefined, { resync: true }))?.pushed).toBe(0);
    expect(t.submits.length).toBe(before);
  });
});

describe("the push after a local write", () => {
  /** Let the timer's push run to its end: until `done` holds, or half a second of real time. */
  const settle = async (done: () => Promise<boolean> | boolean = () => false) => {
    const end = performance.now() + 500;
    while (performance.now() < end && !(await done())) await new Promise((r) => setImmediate(r));
  };
  const mirrored = async (hub: Env) =>
    (await hub.DB.prepare("SELECT COUNT(*) AS n FROM remote_caches").first<{ n: number }>())?.n ?? 0;

  it("goes a few seconds after a burst of writes, in one cycle", async () => {
    const t = await pair();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    await addCache(t.spoke);
    pushSoon(t.spoke);
    vi.advanceTimersByTime(1000);
    await addCache(t.spoke);
    pushSoon(t.spoke);
    vi.advanceTimersByTime(PUSH_SOON_DELAY_MS - 1);
    await settle();
    expect(t.submits).toHaveLength(0); // still inside the pause after the last write
    vi.advanceTimersByTime(1);
    await settle(async () => (await mirrored(t.hub)) === 2);
    expect(t.submits).toHaveLength(1); // both caches in one page
    expect(await mirrored(t.hub)).toBe(2);
  });

  it("still goes out during a steady stream of writes", async () => {
    const t = await pair();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    await addCache(t.spoke);
    for (let ms = 0; ms < PUSH_SOON_MAX_WAIT_MS; ms += 1000) {
      pushSoon(t.spoke);
      vi.advanceTimersByTime(1000);
    }
    await settle(() => t.submits.length > 0);
    expect(t.submits.length).toBeGreaterThanOrEqual(1);
  });

  it("leaves a hub known to be down to the catch-up probe", async () => {
    const t = await pair();
    await t.spoke.DB.prepare("INSERT INTO fed_hub_status (hub, last_attempt_at, offline_since) VALUES (?, 1, 1)")
      .bind(HUB)
      .run();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    await addCache(t.spoke);
    pushSoon(t.spoke);
    vi.advanceTimersByTime(PUSH_SOON_DELAY_MS);
    await settle();
    expect(t.submits).toHaveLength(0);
  });
});
