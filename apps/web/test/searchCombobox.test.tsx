// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment jsdom
// The search field is an ARIA combobox: it reports itself expanded only while its listbox of options is there, the
// listbox holds options only, a status line announces how many results came back (or that none did), and Escape on
// an open list closes the list alone.
import { act, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Sheet } from "../src/ui/Sheet.js";
import { press, render } from "./support/dom.js";

const results = vi.hoisted(() => ({ caches: [] as unknown[], stations: [] as unknown[] }));
vi.mock("../src/api.js", () => ({ searchSuggest: vi.fn(async () => results) }));
const { SearchSuggest } = await import("../src/search/SearchSuggest.js");

function Field(props: { onOuterKey?: () => void }) {
  const [q, setQ] = useState("");
  return (
    <div onKeyDown={(e) => e.key === "Escape" && props.onOuterKey?.()}>
      <SearchSuggest q={q} onChange={setQ} onSubmitRaw={() => {}} onPickCache={() => {}} onPickStation={() => {}} />
      <button type="button" className="type-q" onClick={() => setQ("JN77")}>
        type
      </button>
    </div>
  );
}

async function typeQuery() {
  act(() => document.querySelector<HTMLButtonElement>(".type-q")!.click());
  await act(async () => {
    vi.advanceTimersByTime(200);
  });
  await act(async () => {});
}

const input = () => document.querySelector<HTMLInputElement>("[role=combobox]")!;
const status = () => document.querySelector("[role=status]")?.textContent ?? "";

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = "";
});

describe("search combobox", () => {
  it("with no results: stays collapsed, has no listbox, and says there are no matches", async () => {
    results.caches = [];
    results.stations = [];
    render(<Field />);
    await typeQuery();
    expect(document.querySelector(".search-empty")).not.toBeNull();
    expect(document.querySelector("[role=listbox]")).toBeNull();
    expect(input().getAttribute("aria-expanded")).toBe("false");
    expect(input().hasAttribute("aria-controls")).toBe(false);
    expect(status()).toMatch(/no matches/i);
  });

  it("with results: controls a listbox of options and announces the count", async () => {
    results.caches = [{ kind: "cache", id: 1, code: "AC-1", title: "Clock tower", ownerCall: "OE8APR" }];
    results.stations = [{ kind: "station", callsign: "OE8XYZ-9" }];
    const outer = vi.fn();
    render(<Field onOuterKey={outer} />);
    await typeQuery();
    expect(input().getAttribute("aria-expanded")).toBe("true");
    const list = document.getElementById(input().getAttribute("aria-controls")!);
    expect(list?.getAttribute("role")).toBe("listbox");
    expect([...list!.children].map((c) => c.getAttribute("role"))).toEqual(["option", "option"]);
    expect(status()).toBe("2 results");
    press(input(), "Escape");
    expect(document.querySelector("[role=listbox]")).toBeNull();
    expect(outer).not.toHaveBeenCalled();
  });

  it("in a sheet: Escape on the no-matches note closes the note, then the sheet", async () => {
    results.caches = [];
    results.stations = [];
    const sheetClose = vi.fn();
    render(
      <Sheet title="Search" edge="top" onClose={sheetClose}>
        <Field />
      </Sheet>,
    );
    await typeQuery();
    expect(document.querySelector(".search-empty")).not.toBeNull();
    press(input(), "Escape");
    expect(document.querySelector(".search-empty")).toBeNull();
    expect(sheetClose).not.toHaveBeenCalled();
    press(input(), "Escape");
    expect(sheetClose).toHaveBeenCalledTimes(1);
  });
});
