// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it, expect } from "vitest";
import { coalesceRun, newCoalescer } from "../src/federation_sync.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

/**
 * A stand-in for `syncAllPeersInner`: each run snapshots what the peer holds AT THE MOMENT IT
 * STARTS (a real pull reads `since=<cursor>` off the wire once), then finishes when released.
 * `started` records the snapshot every run took, so a test can see how many pulls ran and what
 * each of them could possibly have mirrored.
 */
function fakePeer() {
  const started: number[] = [];
  const state = { available: 0, gate: null as Promise<void> | null, fail: false };
  const run = async () => {
    const snapshot = state.available;
    started.push(snapshot);
    const g = state.gate;
    state.gate = null;
    if (g) await g;
    if (state.fail) {
      state.fail = false;
      throw new Error("peer down");
    }
    return snapshot;
  };
  return { started, state, run };
}

describe("federation sync coalescing", () => {
  it("hands a mid-run caller a FRESH pull, not the one already in flight", async () => {
    // The federation smoke flake: the node server kicks `runScheduled` -> syncAllPeers at boot.
    // The test then seeds the publisher and POSTs /federation/sync. Joining the boot run returned
    // its pre-seed counts — {caches:0,finds:0,errors:[]} — and the cache only landed on the re-sync.
    const key = {};
    const c = newCoalescer<number>();
    const { started, state, run } = fakePeer();
    const boot = deferred();
    state.gate = boot.promise;

    const bootSync = coalesceRun(key, run, c); // starts before anything exists
    state.available = 1; // the smoke test seeds a cache on the publisher
    const explicit = coalesceRun(key, run, c); // POST /federation/sync
    boot.resolve();

    expect(await bootSync).toBe(0); // the boot run genuinely saw nothing — that is honest
    expect(await explicit).toBe(1); // ...but "sync now" still reports the seeded record
    expect(started).toEqual([0, 1]); // the second pull started after the seed
  });

  it("collapses a whole wave of mid-run callers into ONE follow-up pull", async () => {
    const key = {};
    const c = newCoalescer<number>();
    const { started, state, run } = fakePeer();
    const open = deferred();
    state.gate = open.promise;

    const first = coalesceRun(key, run, c);
    state.available = 3;
    const waiting = [coalesceRun(key, run, c), coalesceRun(key, run, c), coalesceRun(key, run, c)];
    open.resolve();

    expect(await first).toBe(0);
    expect(await Promise.all(waiting)).toEqual([3, 3, 3]); // all served by the same follow-up
    expect(started).toHaveLength(2); // a burst costs at most one extra pull
  });

  it("runs every sequential (awaited) call — a completed run is never reused", async () => {
    const key = {};
    const c = newCoalescer<number>();
    const { started, state, run } = fakePeer();

    expect(await coalesceRun(key, run, c)).toBe(0);
    state.available = 2;
    expect(await coalesceRun(key, run, c)).toBe(2);
    expect(started).toEqual([0, 2]);
  });

  it("a failed pull rejects only its own caller — the queued one still runs", async () => {
    const key = {};
    const c = newCoalescer<number>();
    const { started, state, run } = fakePeer();
    const open = deferred();
    state.gate = open.promise;
    state.fail = true;

    const doomed = coalesceRun(key, run, c);
    state.available = 7;
    const queued = coalesceRun(key, run, c);
    open.resolve();

    await expect(doomed).rejects.toThrow("peer down");
    expect(await queued).toBe(7);
    expect(started).toEqual([0, 7]);
  });

  it("keys are independent (one env's pull never blocks another's)", async () => {
    const a = {},
      b = {};
    const c = newCoalescer<number>();
    const { started, state, run } = fakePeer();
    const open = deferred();
    state.gate = open.promise;

    const onA = coalesceRun(a, run, c);
    const onB = coalesceRun(b, run, c); // different key → starts immediately, not queued behind A
    open.resolve();

    expect(await Promise.all([onA, onB])).toEqual([0, 0]);
    expect(started).toHaveLength(2);
  });
});
