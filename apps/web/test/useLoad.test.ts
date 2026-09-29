// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { startLoad, type LoadState } from "../src/ui/useLoad.js";

/** A promise whose settlement the test controls. */
function deferred<T>() {
  let resolve!: (v: T) => void, reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
const flush = () => new Promise((r) => setTimeout(r, 0));

/** A state cell with the same functional-update shape React's setState has. */
function cell<T>() {
  let s: LoadState<T> = { data: undefined, error: null, loading: false };
  return {
    get: () => s,
    set: (f: (p: LoadState<T>) => LoadState<T>) => {
      s = f(s);
    },
  };
}

describe("startLoad", () => {
  it("marks loading, then stores the data", async () => {
    const c = cell<number>();
    const d = deferred<number>();
    startLoad(() => d.promise, c.set);
    expect(c.get()).toMatchObject({ loading: true, error: null });
    d.resolve(7);
    await flush();
    expect(c.get()).toEqual({ data: 7, error: null, loading: false });
  });

  it("stores the error message and keeps the last data", async () => {
    const c = cell<number>();
    startLoad(() => Promise.resolve(1), c.set);
    await flush();
    startLoad(() => Promise.reject(new Error("offline")), c.set);
    await flush();
    expect(c.get()).toEqual({ data: 1, error: "offline", loading: false });
  });

  it("ignores a response that settles after it was cancelled (stale guard)", async () => {
    const c = cell<string>();
    const slow = deferred<string>();
    const fast = deferred<string>();
    const cancelSlow = startLoad(() => slow.promise, c.set);
    cancelSlow(); // deps changed: a newer request supersedes it
    startLoad(() => fast.promise, c.set);
    fast.resolve("new");
    await flush();
    slow.resolve("old");
    await flush();
    expect(c.get().data).toBe("new");
    expect(c.get().loading).toBe(false);
  });

  it("ignores a rejection after cancel and aborts the request's signal", async () => {
    const c = cell<string>();
    const d = deferred<string>();
    let signal: AbortSignal | undefined;
    const cancel = startLoad((s) => {
      signal = s;
      return d.promise;
    }, c.set);
    cancel();
    expect(signal?.aborted).toBe(true);
    d.reject(new Error("aborted"));
    await flush();
    expect(c.get().error).toBeNull();
  });
});
