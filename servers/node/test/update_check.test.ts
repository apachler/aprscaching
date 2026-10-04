// SPDX-License-Identifier: AGPL-3.0-or-later
// The daily update check: it asks GitHub for the latest release at most once a day, keeps the tag, and the Setup
// checklist compares it with the running version. Off with UPDATE_CHECK=0; a failure never throws.
import { describe, it, expect, vi } from "vitest";
import { newerThan, parseVersion, runUpdateCheck, updateStatus, RELEASE_REPO } from "@aprscaching/gateway/updatecheck";
import { runScheduled } from "@aprscaching/gateway/app";
import { authEnv, call } from "./helpers/authflow.js";

const DAY = 24 * 3600;
const T0 = 1_900_000_000;

type Seen = { url: string; headers: Record<string, string> };

/** A fake GitHub answering /releases/latest with `answer`, recording each request. */
function github(answer: () => Response) {
  const seen: Seen[] = [];
  const f = (async (url: string, init?: RequestInit) => {
    seen.push({ url, headers: { ...(init?.headers as Record<string, string>) } });
    return answer();
  }) as unknown as typeof fetch;
  return { f, seen };
}

const release = (tag: string, extra: Record<string, unknown> = {}, etag = '"e1"') =>
  new Response(
    JSON.stringify({ tag_name: tag, html_url: `https://github.com/${RELEASE_REPO}/releases/tag/${tag}`, ...extra }),
    { status: 200, headers: { etag, "content-type": "application/json" } },
  );

const on = () => authEnv({ UPDATE_CHECK: "1", INSTANCE: "gw.test" });

describe("release versions", () => {
  it("reads a release tag with or without v, and refuses a prerelease or anything else", () => {
    expect(parseVersion("v1.2.3")).toEqual([1, 2, 3]);
    expect(parseVersion("10.0.1")).toEqual([10, 0, 1]);
    expect(parseVersion("v1.2.0-rc.1")).toBeNull();
    expect(parseVersion("latest")).toBeNull();
    expect(parseVersion(null)).toBeNull();
  });

  it("compares by number, part by part", () => {
    expect(newerThan("v1.10.0", "1.9.9")).toBe(true);
    expect(newerThan("v2.0.0", "1.99.99")).toBe(true);
    expect(newerThan("v1.2.3", "1.2.3")).toBe(false);
    expect(newerThan("v1.2.2", "1.2.3")).toBe(false);
    expect(newerThan("v1.3.0-rc.1", "1.2.0")).toBe(false);
    expect(newerThan(null, "1.2.0")).toBe(false);
  });
});

describe("the daily check", () => {
  it("stores the latest release and names the instance to GitHub", async () => {
    const env = on();
    const gh = github(() => release("v99.0.0"));
    await runUpdateCheck(env, gh.f, T0);
    expect(gh.seen).toHaveLength(1);
    expect(gh.seen[0]!.url).toBe(`https://api.github.com/repos/${RELEASE_REPO}/releases/latest`);
    expect(gh.seen[0]!.headers["user-agent"]).toMatch(/^aprscaching\/\S+ \(\+https:\/\/gw\.test\)$/);
    const s = await updateStatus(env);
    expect(s).toMatchObject({ latest: "v99.0.0", available: true, checkedAt: T0, desktop: false });
    expect(s!.url).toBe(`https://github.com/${RELEASE_REPO}/releases/tag/v99.0.0`);
  });

  it("asks at most once a day, and then with the ETag; a 304 keeps the release", async () => {
    const env = on();
    await runUpdateCheck(env, github(() => release("v99.0.0")).f, T0);
    const again = github(() => new Response(null, { status: 304 }));
    await runUpdateCheck(env, again.f, T0 + 3600);
    expect(again.seen).toHaveLength(0);
    await runUpdateCheck(env, again.f, T0 + DAY);
    expect(again.seen).toHaveLength(1);
    expect(again.seen[0]!.headers["if-none-match"]).toBe('"e1"');
    expect(await updateStatus(env)).toMatchObject({ latest: "v99.0.0", checkedAt: T0 + DAY });
  });

  it("offers no update for the running version or an older one", async () => {
    const env = on();
    await runUpdateCheck(env, github(() => release("v0.0.0")).f, T0);
    expect(await updateStatus(env)).toMatchObject({ latest: "v0.0.0", available: false });
  });

  it("ignores a draft or a prerelease, and keeps what it knew", async () => {
    const env = on();
    await runUpdateCheck(env, github(() => release("v99.0.0")).f, T0);
    await runUpdateCheck(env, github(() => release("v100.0.0", { prerelease: true })).f, T0 + DAY);
    await runUpdateCheck(env, github(() => release("v101.0.0", { draft: true })).f, T0 + 2 * DAY);
    expect(await updateStatus(env)).toMatchObject({ latest: "v99.0.0", available: true });
  });

  it("makes no request with UPDATE_CHECK=0, and reports nothing", async () => {
    const env = authEnv({ UPDATE_CHECK: "0" });
    const gh = github(() => release("v99.0.0"));
    await runUpdateCheck(env, gh.f, T0);
    expect(gh.seen).toHaveLength(0);
    expect(await updateStatus(env)).toBeNull();
  });

  it("never throws on a network failure, an error status or a broken answer", async () => {
    const env = on();
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
    try {
      await expect(
        runUpdateCheck(
          env,
          (async () => {
            throw new TypeError("fetch failed");
          }) as unknown as typeof fetch,
          T0,
        ),
      ).resolves.toBeUndefined();
      await runUpdateCheck(env, github(() => new Response("rate limited", { status: 403 })).f, T0);
      await runUpdateCheck(env, github(() => new Response("{not json", { status: 200 })).f, T0);
      expect(debug).toHaveBeenCalled();
    } finally {
      debug.mockRestore();
    }
    expect(await updateStatus(env)).toMatchObject({ latest: null, available: false, checkedAt: null });
  });

  it("reaches the sysop only: the Setup checklist carries it, and a member cannot read it", async () => {
    const env = on();
    await runUpdateCheck(env, github(() => release("v99.0.0")).f, T0);
    const op = await call(env, "GET", "/api/admin/setup", undefined, { "x-operator-secret": "test-operator-secret" });
    expect(op.status).toBe(200);
    expect(op.data.update).toMatchObject({ latest: "v99.0.0", available: true });
    const anon = await call(env, "GET", "/api/admin/setup");
    expect(anon.status).not.toBe(200);
    expect(JSON.stringify(anon.data)).not.toContain("v99.0.0");
  });
});

describe("the nightly task", () => {
  it("leaves GitHub alone with UPDATE_CHECK=0", async () => {
    const room = { fetch: async () => new Response(null, { status: 204 }) };
    const env = authEnv({ UPDATE_CHECK: "0", ROOMS: { idFromName: (n: string) => n, get: () => room } });
    const spy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("no network in tests"));
    try {
      await runScheduled(env);
      const hosts = spy.mock.calls.map((c) => new URL(c[0] instanceof Request ? c[0].url : String(c[0])).hostname);
      expect(hosts.filter((h) => h === "api.github.com")).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });
});
