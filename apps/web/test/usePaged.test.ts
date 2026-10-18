// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment jsdom
// A paged list shows the answer to its newest request: a slower answer for an earlier filter, or a Load more
// that lands after a reset, never writes over it. A refresh merges the newest page into what is loaded.
import { createElement } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { usePaged } from "../src/ui/usePaged.js";

interface Row {
  id: number;
  v: string;
}
type Page = { items: Row[]; nextCursor: string | null; hasMore: boolean };
interface Call {
  filter: string;
  cursor: string | null;
  resolve: (p: Page) => void;
}

let calls: Call[] = [];
let hook: ReturnType<typeof usePaged<Row>>;
function Harness(props: { filter: string }) {
  hook = usePaged<Row>(
    (cursor) => new Promise<Page>((resolve) => calls.push({ filter: props.filter, cursor, resolve })),
    [props.filter],
    { keyOf: (r) => r.id },
  );
  return null;
}
const rows = (...ids: number[]) => ids.map((id) => ({ id, v: `v${id}` }));
const page = (items: Row[], nextCursor: string | null = null): Page => ({ items, nextCursor, hasMore: !!nextCursor });

let root: Root;
const render = (filter: string) => act(() => root.render(createElement(Harness, { filter })));
const answer = (c: Call | undefined, p: Page) => act(async () => c!.resolve(p));

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  root = createRoot(document.createElement("div"));
  calls = [];
});
afterEach(() => act(() => root.unmount()));

describe("usePaged", () => {
  it("keeps the newer filter's page when the earlier request answers last", async () => {
    render("all");
    render("mine");
    const all = calls.find((c) => c.filter === "all");
    const mine = calls.find((c) => c.filter === "mine");
    await answer(mine, page(rows(1), "m1"));
    await answer(all, page(rows(7, 8), "a1"));
    expect(hook.items.map((r) => r.id)).toEqual([1]);
    expect(hook.loading).toBe(false);
  });

  it("drops a Load more that answers after a reset", async () => {
    render("all");
    await answer(calls[0], page(rows(5, 4), "c1"));
    act(() => hook.loadMore());
    const more = calls[1];
    act(() => hook.reload());
    await answer(calls[2], page(rows(6, 5), "c2"));
    await answer(more, page(rows(3, 2)));
    expect(hook.items.map((r) => r.id)).toEqual([6, 5]);
  });

  it("merges a refreshed first page into the loaded pages and keeps the cursor", async () => {
    render("all");
    await answer(calls[0], page(rows(5, 4), "c1"));
    act(() => hook.loadMore());
    await answer(calls[1], page(rows(3, 2), "c2"));
    act(() => hook.refresh());
    expect(calls[2]!.cursor).toBeNull();
    await answer(calls[2], page([{ id: 6, v: "v6" }, { id: 5, v: "acked" }, ...rows(4)], "x"));
    expect(hook.items.map((r) => r.id)).toEqual([6, 5, 4, 3, 2]);
    expect(hook.items[1]!.v).toBe("acked");
    expect(hook.hasMore).toBe(true);
    act(() => hook.loadMore());
    expect(calls[3]!.cursor).toBe("c2");
  });
});
