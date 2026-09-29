// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { SURFACES } from "@aprscaching/shared";
import {
  MAP,
  NAV_ITEMS,
  TAB_ITEMS,
  activeKey,
  createViewHistory,
  sameView,
  viewFromQuery,
  viewQuery,
  type View,
} from "../src/nav.js";

/** An in-memory session history with the browser's semantics: push truncates forward entries, and
 *  back/forward settle asynchronously with a popstate event. */
class FakeWindow extends EventTarget {
  entries: { state: unknown; url: string }[] = [];
  index = 0;
  constructor(url: string) {
    super();
    this.entries = [{ state: null, url }];
  }
  private get cur() {
    return this.entries[this.index]!;
  }
  get location() {
    const u = new URL(this.cur.url, "http://app.test");
    return { pathname: u.pathname, search: u.search, hash: u.hash };
  }
  history = {
    get state() {
      return self.cur.state;
    },
    pushState: (state: unknown, _t: string, url: string) => {
      this.entries = this.entries.slice(0, this.index + 1);
      this.entries.push({ state, url });
      this.index++;
    },
    replaceState: (state: unknown, _t: string, url: string) => {
      this.entries[this.index] = { state, url };
    },
    back: () => this.go(-1),
    forward: () => this.go(1),
  };
  go(delta: number) {
    setTimeout(() => {
      const next = this.index + delta;
      if (next < 0 || next >= this.entries.length) return;
      this.index = next;
      this.dispatchEvent(new Event("popstate"));
    }, 0);
  }
  get url() {
    return this.cur.url;
  }
}
let self: FakeWindow;
const makeWin = (url = "/#9/47.07/15.42") => (self = new FakeWindow(url));
const settle = () => new Promise((r) => setTimeout(r, 5));

const nearby: View = { kind: "panel", key: "nearby" };
const activity: View = { kind: "panel", key: "activity" };

describe("the surface table", () => {
  it("resolves every shared surface's ?view= deep link to a web view", () => {
    for (const s of SURFACES) {
      if (s.view === null) continue;
      expect(viewFromQuery(`?view=${s.view}`), s.key).not.toBeNull();
    }
  });

  it("round-trips every view through its query string", () => {
    const views: View[] = [
      nearby,
      { kind: "panel", key: "ranks" },
      { kind: "panel", key: "admin" },
      { kind: "app", id: "terminal" },
      { kind: "app", id: "bbs" },
      { kind: "station", call: "OE8APR-9" },
    ];
    for (const v of views) expect(viewFromQuery(viewQuery(v, ""))).toEqual(v);
    expect(viewQuery(MAP, "?v=abc&view=nearby")).toBe("?v=abc");
    expect(viewFromQuery("?view=bogus")).toBeNull();
    expect(viewFromQuery("?view=station")).toBeNull();
  });

  it("lights one rail item and one tab per view", () => {
    const rail = new Set([...NAV_ITEMS.map((i) => i.key), "terminal"]);
    const tabs = new Set(TAB_ITEMS.map((i) => i.key));
    expect(activeKey(MAP, rail)).toBe("map");
    expect(activeKey(nearby, rail)).toBe("nearby");
    expect(activeKey({ kind: "panel", key: "ranks" }, rail)).toBe("ranks");
    expect(activeKey({ kind: "panel", key: "filter" }, rail)).toBe("map");
    expect(activeKey({ kind: "app", id: "terminal" }, rail)).toBe("terminal"); // pinned
    expect(activeKey({ kind: "app", id: "rig" }, rail)).toBe("shack"); // not pinned → its launcher
    expect(activeKey({ kind: "station", call: "X" }, rail)).toBe("map");
    expect(activeKey({ kind: "panel", key: "messages" }, tabs)).toBe("map");
    expect(activeKey({ kind: "panel", key: "profile" }, tabs)).toBe("profile");
    expect(TAB_ITEMS.map((t) => t.key)).toEqual(["map", "nearby", "activity", "profile"]);
  });

  it("compares views by value", () => {
    expect(sameView(nearby, { kind: "panel", key: "nearby" })).toBe(true);
    expect(sameView(nearby, activity)).toBe(false);
    expect(sameView({ kind: "station", call: "A" }, { kind: "station", call: "B" })).toBe(false);
  });
});

describe("view history", () => {
  it("pushes one entry when something opens, and switching panels replaces it", () => {
    const w = makeWin();
    const h = createViewHistory(w, () => {});
    h.sync(nearby, true);
    expect(w.entries).toHaveLength(2);
    expect(w.url).toBe("/?view=nearby#9/47.07/15.42");
    h.sync(activity, true);
    expect(w.entries).toHaveLength(2);
    expect(w.url).toBe("/?view=activity#9/47.07/15.42");
    h.dispose();
  });

  it("the back button closes the open view instead of leaving the app", async () => {
    const w = makeWin();
    const popped: View[] = [];
    const h = createViewHistory(w, (v) => popped.push(v));
    h.sync(nearby, true);
    w.history.back();
    await settle();
    expect(popped).toEqual([MAP]);
    expect(w.index).toBe(0);
    h.sync(MAP, false); // the app re-renders with the popped view: no further navigation
    await settle();
    expect(w.index).toBe(0);
    expect(w.entries).toHaveLength(2); // forward still re-opens it
    w.history.forward();
    await settle();
    expect(popped).toEqual([MAP, nearby]);
    h.dispose();
  });

  it("closing from the UI pops the entry, so a later back leaves nothing open", async () => {
    const w = makeWin();
    const popped: View[] = [];
    const h = createViewHistory(w, (v) => popped.push(v));
    h.sync(nearby, true);
    h.sync(MAP, false);
    await settle();
    expect(w.index).toBe(0);
    expect(w.url).toBe("/#9/47.07/15.42");
    expect(popped).toEqual([]); // the app already shows the map
    h.dispose();
  });

  it("opening again before the pop settles pushes the new view after it", async () => {
    const w = makeWin();
    const popped: View[] = [];
    const h = createViewHistory(w, (v) => popped.push(v));
    h.sync(nearby, true);
    h.sync(MAP, false);
    h.sync(activity, true); // a second click lands before the traversal
    await settle();
    expect(popped).toEqual([]);
    expect(w.index).toBe(1);
    expect(w.url).toBe("/?view=activity#9/47.07/15.42");
    h.dispose();
  });

  it("a deep link becomes a pushed entry above a clean map entry", () => {
    const w = makeWin("/?view=nearby&v=share1#9/47/15");
    const h = createViewHistory(w, () => {});
    h.sync(MAP, false); // first render: nothing open yet
    expect(w.url).toBe("/?v=share1#9/47/15");
    h.sync(nearby, true); // the deep link opens
    expect(w.entries.map((e) => e.url)).toEqual(["/?v=share1#9/47/15", "/?v=share1&view=nearby#9/47/15"]);
    h.dispose();
  });

  it("keeps the map where it is when an entry with an older map hash is restored", async () => {
    const w = makeWin("/#9/47.07/15.42");
    let hash = "#9/47.07/15.42";
    const h = createViewHistory(
      w,
      () => {},
      () => hash,
    );
    h.sync(nearby, true);
    hash = "#12/48.2/16.37"; // the user panned while the panel was open
    w.history.back();
    await settle();
    expect(w.url).toBe("/#12/48.2/16.37");
    h.dispose();
  });

  it("stops listening once disposed", async () => {
    const w = makeWin();
    const popped: View[] = [];
    const h = createViewHistory(w, (v) => popped.push(v));
    h.sync(nearby, true);
    h.dispose();
    w.history.back();
    await settle();
    expect(popped).toEqual([]);
  });
});
