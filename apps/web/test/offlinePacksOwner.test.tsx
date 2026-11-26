// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment jsdom
// On a shared device a player's private offline data — the owner maintenance pack (every cache they own, unlisted
// ones too) and the stage reveals they opened offline — is kept under their call, shown only to them, and deleted
// when they sign out or another player signs in. Area packs hold only public caches and stay for whoever is next.
import "fake-indexeddb/auto";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sealStage, type PackCache, type PackResponse } from "@aprscaching/shared";
import { render } from "./support/dom.js";

const answers = vi.hoisted(() => ({ session: { callsign: null as string | null } as object | Error }));
vi.mock("../src/api.js", async (orig) => ({
  ...(await orig<typeof import("../src/api.js")>()),
  getSession: vi.fn(async () => {
    if (answers.session instanceof Error) throw answers.session;
    return answers.session;
  }),
  logout: vi.fn(async () => ({ ok: true })),
  logoutAll: vi.fn(async () => ({ ok: true })),
}));
vi.mock("../src/push.js", () => ({ disablePush: vi.fn(async () => {}) }));
vi.mock("../src/platform/PlatformContext.js", () => ({
  usePlatform: () => ({ callsign: "OE8AAA", verified: false, map: null, session: { callsign: "OE8AAA" } }),
}));

const { ApiError, getStages, offlineReady, queuedLogs, setQueueOwner, unlockStage } = await import("../src/api.js");
const { useSession } = await import("../src/identity/useSession.js");
const { packCache, packCachesInBox, packSearch, userPacks } = await import("../src/offline/packs.js");
const { storePack } = await import("../src/offline/download.js");
const { shownPackCaches } = await import("../src/offline/owner.js");
const { OfflinePanel } = await import("../src/offline/OfflinePanel.js");

const SERIAL = "04:A2:5F:1B:3C:80:90";
const REVEALS = "acs.stages.unlocked";
const BOX: [number, number, number, number] = [15, 47, 15.5, 47.5];

let hook: ReturnType<typeof useSession>;
function Probe() {
  hook = useSession();
  return null;
}
async function settle() {
  for (let i = 0; i < 200 && hook.loading; i++) await act(() => new Promise((r) => setTimeout(r, 10)));
  expect(hook.loading).toBe(false);
}

const cache = (id: number, extra: Partial<PackCache> = {}) =>
  ({
    globalId: `x:cache:${id}`,
    id,
    code: `AC-${id}`,
    ownerCall: "OE8AAA",
    title: `Cache ${id}`,
    type: "traditional",
    status: "active",
    lat: 47.1,
    lon: 15.1,
    fedScope: "public",
    tags: [],
    stages: [],
    logs: [],
    images: [],
    ...extra,
  }) as unknown as PackCache;

/** A public area pack holding a multi-stage cache whose NFC stage the pack carries sealed. */
async function seedAreaPack() {
  const sealed = await sealStage(SERIAL, { lat: 47.11, lon: 15.12, clue: "behind the oak", mediaUrl: null }, 1000);
  const st = await offlineReady();
  await st.putPack(
    {
      id: "p-area",
      name: "JN77",
      area: { locator: "JN77" },
      filters: { types: [] },
      images: "none",
      instance: "x",
      createdAt: 1,
      refreshedAt: 1,
      generation: "g",
      cacheCount: 1,
      sizeBytes: 1,
    },
    [
      cache(77, {
        stages: [
          { stageNo: 0, unlock: "open", open: { lat: 47.1, lon: 15.1, clue: "start", mediaUrl: null } },
          { stageNo: 1, unlock: "nfc", sealed },
        ],
      } as Partial<PackCache>),
    ],
  );
}

/** The signed-in owner's maintenance pack, stored the way the Offline panel stores it, with one unlisted cache. */
async function seedOwnerPack(
  fetcher: (url: string) => Promise<Response> = async () => new Response(new Blob(["img"])),
) {
  const st = await offlineReady();
  const data: PackResponse = {
    instance: "x",
    generation: "g1",
    builtAt: 1,
    caches: [
      cache(501, {
        fedScope: "unlisted",
        title: "My unlisted cache",
        attention: ["disabled"],
        images: [
          {
            id: 9,
            url: "/api/media/k9",
            contentType: "image/jpeg",
            title: null,
            bytes: 3,
            thumbUrl: "/api/media/t9",
            thumbBytes: 3,
          },
        ],
      } as Partial<PackCache>),
    ],
  };
  await storePack(
    st,
    fetcher,
    "",
    {
      id: "mine-a",
      name: "My caches",
      area: { mine: true },
      filters: { types: [] },
      images: "thumbs",
      createdAt: 2,
      refreshedAt: 2,
    },
    data,
  );
}

/** A signed in, with their owner pack and one stage revealed offline. */
async function signInAsAWithPrivateData() {
  answers.session = { callsign: "OE8AAA" };
  render(<Probe />);
  await settle();
  await seedAreaPack();
  await act(() => seedOwnerPack());
  expect(await unlockStage(77, 1, "OE8AAA", undefined, SERIAL)).toMatchObject({ unlocked: true, offline: true });
  // A sees all of it
  const st = await offlineReady();
  expect((await packCache(st, 501))?.cache.title).toBe("My unlisted cache");
  expect((await userPacks(st)).map((p) => p.id)).toContain("mine-a");
  expect((await getStages(77)).stages[1]).toMatchObject({ unlocked: true, clue: "behind the oak" });
}

/** What of A's private data the device still holds, read from the store itself. */
async function aLeftOnDevice() {
  const st = await offlineReady();
  return {
    packs: (await st.packs()).filter((p) => p.id === "mine-a").length,
    caches: (await st.packCaches("mine-a")).length,
    images: (await st.blobKeys("mine-a")).length,
    reveals: ((await st.kvGet(REVEALS)) ?? "").includes("behind the oak"),
  };
}
const NOTHING = { packs: 0, caches: 0, images: 0, reveals: false };

/** What the app shows the current player of A's private data. */
async function aShown() {
  const st = await offlineReady();
  return {
    ownerPackCache: (await packCache(st, 501)) != null,
    listed: (await userPacks(st)).some((p) => p.id === "mine-a"),
    found: (await packSearch(st, "unlisted", 10)).length,
    onMap: (await packCachesInBox(st, BOX)).caches.some((c) => c.id === 501),
    reveal: (await getStages(77)).stages[1]?.unlocked ?? null,
  };
}
const HIDDEN = { ownerPackCache: false, listed: false, found: 0, onMap: false, reveal: false };

beforeEach(async () => {
  vi.stubGlobal("fetch", () => Promise.reject(new TypeError("offline")));
  localStorage.clear();
  const st = await offlineReady();
  for (const p of await st.packs()) await st.deletePack(p.id);
  await st.kvSet("acs.sync.owner", "");
  await st.kvSet(REVEALS, "");
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("a player's private offline data is read only for its owner", () => {
  it("B, signed in after A on the same store, sees neither A's owner pack nor A's stage reveals", async () => {
    await signInAsAWithPrivateData();
    // B's session is recorded on the store with A's data still on it: what is shown follows the owner
    const st = await offlineReady();
    await st.kvSet("acs.sync.owner", "OE8BBB");
    expect(await aShown()).toEqual(HIDDEN);
    // and A, back, sees it again
    await st.kvSet("acs.sync.owner", "OE8AAA");
    expect(await aShown()).toMatchObject({ ownerPackCache: true, listed: true, reveal: true });
  });

  it("an owner pack is stored only for a known owner", async () => {
    await expect(seedOwnerPack()).rejects.toThrow(/sign in/);
    expect((await (await offlineReady()).packs()).map((p) => p.id)).not.toContain("mine-a");
  });
});

describe("a player's private offline data leaves the device with the player", () => {
  it("is deleted on sign-out", async () => {
    await signInAsAWithPrivateData();
    await act(() => hook.signOut());
    expect(await aLeftOnDevice()).toEqual(NOTHING);
  });

  it("is deleted on signing out everywhere", async () => {
    await signInAsAWithPrivateData();
    await act(() => hook.signOutEverywhere());
    expect(await aLeftOnDevice()).toEqual(NOTHING);
  });

  it("is deleted when the session hook finds another player signed in", async () => {
    await signInAsAWithPrivateData();
    answers.session = { callsign: "OE8BBB" };
    await act(() => hook.refresh());
    expect(await aLeftOnDevice()).toEqual(NOTHING);
    expect(await aShown()).toEqual(HIDDEN);
  });
});

describe("with no known owner nothing private is shown", () => {
  it("hides it once the server no longer answers for the session", async () => {
    await signInAsAWithPrivateData();
    answers.session = new ApiError("no session", 401, null);
    await act(() => hook.refresh());
    expect(await aShown()).toEqual(HIDDEN);
  });

  it("hides it offline without a remembered session", async () => {
    await signInAsAWithPrivateData();
    localStorage.clear();
    answers.session = new TypeError("Failed to fetch");
    await act(() => hook.refresh());
    expect(hook.signedIn).toBe(false);
    expect(await aShown()).toEqual(HIDDEN);
  });
});

describe("public area packs stay for the next player", () => {
  it("keeps an area pack across A's sign-out, and B's offline map reads it", async () => {
    await signInAsAWithPrivateData();
    await act(() => hook.signOut());
    answers.session = { callsign: "OE8BBB" };
    await act(() => hook.refresh());
    const st = await offlineReady();
    expect((await st.packs()).map((p) => p.id)).toEqual(["p-area"]);
    const view = await packCachesInBox(st, BOX);
    expect(view.caches.map((c) => c.id)).toEqual([77]);
    expect(view.source?.name).toBe("JN77");
    // B opens the stage A revealed: locked for B, from the area pack
    expect((await getStages(77)).stages.map((s) => s.unlocked)).toEqual([true, false]);
  });
});

describe("the owner moves before anything is deleted", () => {
  it("shows B nothing of A's when deleting A's data fails", async () => {
    await signInAsAWithPrivateData();
    const st = await offlineReady();
    vi.spyOn(st, "deletePack").mockRejectedValue(new Error("quota"));
    answers.session = { callsign: "OE8BBB" };
    await act(() => hook.refresh());
    expect(await st.kvGet("acs.sync.owner")).toBe("OE8BBB");
    expect(await aShown()).toEqual(HIDDEN);
    expect(await queuedLogs()).toEqual([]);
  });

  it("signs out to nobody when deleting fails", async () => {
    await signInAsAWithPrivateData();
    const st = await offlineReady();
    vi.spyOn(st, "deletePack").mockRejectedValue(new Error("quota"));
    await act(() => hook.signOut());
    expect(await st.kvGet("acs.sync.owner")).toBe("");
    expect(await aShown()).toEqual(HIDDEN);
    expect(await queuedLogs()).toEqual([]);
  });
});

describe("a pack being downloaded when its owner signs out", () => {
  it("is not kept, nor its images", async () => {
    answers.session = { callsign: "OE8AAA" };
    render(<Probe />);
    await settle();
    let signedOut = false;
    const fetcher = async () => {
      if (!signedOut) {
        signedOut = true;
        await hook.signOut();
      }
      return new Response(new Blob(["img"]));
    };
    await act(() => expect(seedOwnerPack(fetcher)).rejects.toThrow(/signed out/));
    expect(signedOut).toBe(true);
    expect(await aLeftOnDevice()).toEqual(NOTHING);
  });
});

describe("an owner pack stored without an owner", () => {
  /** An owner pack as stored before packs carried their owner. */
  async function seedUntagged() {
    await seedAreaPack();
    const st = await offlineReady();
    await st.putPack(
      {
        id: "mine-a",
        name: "My caches",
        area: { mine: true },
        filters: { types: [] },
        images: "none",
        instance: "x",
        createdAt: 2,
        refreshedAt: 2,
        generation: "g",
        cacheCount: 1,
        sizeBytes: 1,
      },
      [cache(501, { title: "My unlisted cache", fedScope: "unlisted" } as Partial<PackCache>)],
    );
    return st;
  }

  it("is shown to nobody, with or without an owner known", async () => {
    const st = await seedUntagged();
    const hidden = { ownerPackCache: false, listed: false, found: 0, onMap: false };
    expect(await aShown()).toMatchObject(hidden);
    await st.kvSet("acs.sync.owner", "OE8AAA");
    expect(await aShown()).toMatchObject(hidden);
  });

  it("is deleted once a player is known", async () => {
    const st = await seedUntagged();
    await setQueueOwner("OE8AAA");
    expect((await st.packs()).map((p) => p.id)).not.toContain("mine-a");
  });
});

describe("the Offline panel", () => {
  const text = () => document.body.textContent ?? "";
  async function until(ok: () => boolean) {
    for (let i = 0; i < 200 && !ok(); i++) await act(() => new Promise((r) => setTimeout(r, 10)));
  }

  it("drops the last player's pack and its caches when another player signs in", async () => {
    await signInAsAWithPrivateData();
    render(<OfflinePanel onClose={() => {}} />);
    await until(() => text().includes("1 cache needs a visit"));
    expect(text()).toContain("My caches");
    answers.session = { callsign: "OE8BBB" };
    await act(() => hook.refresh());
    await until(() => !text().includes("My caches"));
    expect(text()).not.toContain("My caches");
    expect(text()).not.toContain("needs a visit");
  });

  it("reads no caches of a pack another player's session hides", async () => {
    await signInAsAWithPrivateData();
    const st = await offlineReady();
    expect((await shownPackCaches(st, "mine-a")).map((c) => c.id)).toEqual([501]);
    // another tab recorded B: this tab's list still names A's pack, its caches are not read
    await st.kvSet("acs.sync.owner", "OE8BBB");
    expect(await shownPackCaches(st, "mine-a")).toEqual([]);
    expect((await shownPackCaches(st, "p-area")).map((c) => c.id)).toEqual([77]);
  });
});
