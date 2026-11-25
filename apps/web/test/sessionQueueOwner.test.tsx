// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment jsdom
// The offline queue sends only the signed-in call's entries, read from the stored queue owner: the session hook
// sets it from each server answer and clears it on sign-out, so on a shared device the next player's session
// never holds the last player's call.
import "fake-indexeddb/auto";
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
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

const { ApiError, offlineReady } = await import("../src/api.js");
const { useSession } = await import("../src/identity/useSession.js");

let hook: ReturnType<typeof useSession>;
function Probe() {
  hook = useSession();
  return null;
}
const storedOwner = async () => (await offlineReady()).kvGet("acs.sync.owner");
/** Wait for the first session answer to reach the hook (opening the offline store takes a moment). */
async function settle() {
  for (let i = 0; i < 200 && hook.loading; i++) await act(() => new Promise((r) => setTimeout(r, 10)));
  expect(hook.loading).toBe(false);
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("the offline queue's owner follows the session", () => {
  it("is set from the server's answer, cleared on sign-out, and set to the next player's call", async () => {
    answers.session = { callsign: "OE8AAA" };
    render(<Probe />);
    await settle();
    expect(await storedOwner()).toBe("OE8AAA");

    answers.session = { callsign: null };
    await act(() => hook.signOut());
    expect(await storedOwner()).toBe("");

    answers.session = { callsign: "OE8BBB" };
    await act(() => hook.refresh());
    expect(await storedOwner()).toBe("OE8BBB");
  });

  it("keeps the remembered call without a connection, and none once the server says there is no session", async () => {
    answers.session = { callsign: "OE8AAA" };
    render(<Probe />);
    await settle();
    answers.session = new TypeError("Failed to fetch");
    await act(() => hook.refresh());
    expect(await storedOwner()).toBe("OE8AAA");
    answers.session = new ApiError("no session", 401, null);
    await act(() => hook.refresh());
    expect(await storedOwner()).toBe("");
  });

  it("is cleared by signing out everywhere", async () => {
    answers.session = { callsign: "OE8AAA" };
    render(<Probe />);
    await settle();
    expect(await storedOwner()).toBe("OE8AAA");
    await act(() => hook.signOutEverywhere());
    expect(await storedOwner()).toBe("");
  });
});
