// SPDX-License-Identifier: AGPL-3.0-or-later
// The device database copy: fetched from DEVICEID_URL at most once a day, kept in deviceid_cache so a restart or an
// offline box keeps naming devices, and never replaced by a failed or malformed answer.
import { describe, it, expect } from "vitest";
import { deviceIndex, deviceIdUrl, refreshDeviceIds, stationDevice } from "../src/deviceid.js";
import type { Env } from "../src/env.js";

const URL_ = "https://deviceid.test/tocalls.dense.json";
const T0 = 1_900_000_000;
const DAY = 24 * 3600;

// a hand-written table in the database's shape; the tests never read the real data
const TABLE = {
  classes: { software: { shown: "Desktop software" } },
  tocalls: { "APDW??": { vendor: "WB2OSZ", model: "Dire Wolf", class: "software" } },
  mice: { _0: { vendor: "Yaesu", model: "FT3D" } },
};

interface Row {
  body: string | null;
  etag: string | null;
  fetched_at: number | null;
  checked_at: number;
}

/** A database holding the one deviceid_cache row, shared by the envs made over it (a restart keeps it). */
function store(initial: Row | null = null) {
  const box = { row: initial };
  const db = () => ({
    prepare(sql: string) {
      return {
        bind: (...a: unknown[]) => ({
          first: async () => (sql.includes("FROM deviceid_cache") ? box.row : null),
          run: async () => {
            if (sql.includes("INSERT INTO deviceid_cache"))
              box.row = {
                body: a[0] as string | null,
                etag: a[1] as string | null,
                fetched_at: a[2] as number | null,
                checked_at: a[3] as number,
              };
            return { meta: {} };
          },
        }),
        first: async () => (sql.includes("FROM deviceid_cache") ? box.row : null),
      };
    },
  });
  return { box, env: (...u: [string?]) => ({ DEVICEID_URL: u.length ? u[0] : URL_, DB: db() }) as unknown as Env };
}

type Seen = { url: string; headers: Record<string, string> };
function remote(answer: () => Response | Promise<Response>) {
  const seen: Seen[] = [];
  const f = (async (url: string, init?: RequestInit) => {
    seen.push({ url, headers: { ...(init?.headers as Record<string, string>) } });
    return answer();
  }) as unknown as typeof fetch;
  return { f, seen };
}
const ok = (body: unknown = TABLE, etag = '"v1"') =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), { status: 200, headers: { etag } });

const name = async (env: Env, tocall: string) =>
  (await stationDevice(env, { tocall, mice_prefix: null, mice_suffix: null }))?.name ?? null;

describe("the device database copy", () => {
  it("reads the database's own address while DEVICEID_URL is unset", () => {
    expect(deviceIdUrl(store().env(undefined))).toBe("https://aprs-deviceid.aprsfoundation.org/tocalls.dense.json");
  });

  it("is off with DEVICEID_URL set empty or not http(s): nothing fetched, nothing named", async () => {
    const s = store();
    for (const u of ["", "  ", "ftp://x/y"]) {
      const env = s.env(u);
      const r = remote(() => ok());
      expect(deviceIdUrl(env)).toBeNull();
      await refreshDeviceIds(env, r.f, T0);
      expect(r.seen).toHaveLength(0);
      expect(await deviceIndex(env)).toBeNull();
    }
  });

  it("fetches once, keeps the body, and names devices from it after a restart", async () => {
    const s = store();
    const r = remote(() => ok());
    await refreshDeviceIds(s.env(), r.f, T0);
    expect(r.seen.map((x) => x.url)).toEqual([URL_]);
    expect(r.seen[0]!.headers["user-agent"]).toMatch(/^aprscaching\//);
    expect(s.box.row).toMatchObject({ etag: '"v1"', fetched_at: T0, checked_at: T0 });
    // a fresh env over the same database: the copy is read from the row, no request
    const restarted = s.env();
    expect(await name(restarted, "APDW17")).toBe("Dire Wolf");
    expect(
      await stationDevice(restarted, { tocall: null, mice_prefix: "`", mice_suffix: "_0" }).then((d) => d?.name),
    ).toBe("FT3D");
  });

  it("asks at most once a day, then with If-None-Match, and a 304 keeps the copy", async () => {
    const s = store();
    await refreshDeviceIds(s.env(), remote(() => ok()).f, T0);
    const again = remote(() => new Response(null, { status: 304 }));
    await refreshDeviceIds(s.env(), again.f, T0 + 3600);
    expect(again.seen).toHaveLength(0);
    await refreshDeviceIds(s.env(), again.f, T0 + DAY);
    expect(again.seen[0]!.headers["if-none-match"]).toBe('"v1"');
    expect(s.box.row).toMatchObject({ fetched_at: T0, checked_at: T0 + DAY });
    expect(await name(s.env(), "APDW17")).toBe("Dire Wolf");
  });

  it("keeps the last good copy when the source fails, answers garbage, or the box is offline", async () => {
    const s = store();
    await refreshDeviceIds(s.env(), remote(() => ok()).f, T0);
    const answers: (() => Response | Promise<Response>)[] = [
      () => new Response("down", { status: 503 }),
      () => ok("not json"),
      () => ok({ meta: {} }),
      () => Promise.reject(new Error("getaddrinfo ENOTFOUND")),
    ];
    let t = T0;
    for (const a of answers) {
      t += DAY;
      await expect(refreshDeviceIds(s.env(), remote(a).f, t)).resolves.toBeUndefined();
      expect(await name(s.env(), "APDW17")).toBe("Dire Wolf");
    }
    expect(s.box.row?.fetched_at).toBe(T0);
  });

  it("names nothing while offline with no copy yet, and never throws", async () => {
    const s = store();
    await refreshDeviceIds(s.env(), remote(() => Promise.reject(new Error("offline"))).f, T0);
    expect(s.box.row).toMatchObject({ body: null, checked_at: T0 });
    expect(await name(s.env(), "APDW17")).toBeNull();
  });

  it("names nothing once the operator turns it off, though a copy is kept", async () => {
    const s = store();
    await refreshDeviceIds(s.env(), remote(() => ok()).f, T0);
    expect(await name(s.env(""), "APDW17")).toBeNull();
  });
});
