// SPDX-License-Identifier: AGPL-3.0-or-later
// The operator check belongs to the account it was asked for: a new account (or a switch to another call)
// starts hidden, and an answer for the previous one that lands late never reveals the admin surface.
import { describe, expect, it } from "vitest";
import { startOperatorCheck, type OperatorState } from "../src/identity/operatorCheck.js";

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("startOperatorCheck", () => {
  it("hides the admin surface while the check for a new account runs", async () => {
    let s: OperatorState = { sysop: true, pending: false, known: true };
    startOperatorCheck(
      true,
      () => new Promise(() => {}),
      (n) => (s = n),
    );
    expect(s).toEqual({ sysop: false, pending: false, known: false });
  });

  it("drops the previous account's late answer", async () => {
    let s: OperatorState = { sysop: false, pending: false, known: false };
    const set = (n: OperatorState) => (s = n);
    const sysopsAnswer = deferred<{ sysop: boolean }>();
    const cancel = startOperatorCheck(true, () => sysopsAnswer.promise, set);
    cancel(); // the session moved to another call
    startOperatorCheck(true, () => Promise.resolve({ sysop: false }), set);
    await flush();
    sysopsAnswer.resolve({ sysop: true });
    await flush();
    expect(s).toEqual({ sysop: false, pending: false, known: true });
  });

  it("reports the operator, a pending verification, and a failure as not the operator", async () => {
    let s: OperatorState | null = null;
    startOperatorCheck(
      true,
      () => Promise.resolve({ sysop: true }),
      (n) => (s = n),
    );
    await flush();
    expect(s).toEqual({ sysop: true, pending: false, known: true });
    startOperatorCheck(
      true,
      () => Promise.resolve({ sysop: false, pending: "verify" }),
      (n) => (s = n),
    );
    await flush();
    expect(s).toEqual({ sysop: false, pending: true, known: true });
    startOperatorCheck(
      true,
      () => Promise.reject(new Error("offline")),
      (n) => (s = n),
    );
    await flush();
    expect(s).toEqual({ sysop: false, pending: false, known: true });
    startOperatorCheck(
      false,
      () => Promise.resolve({ sysop: true }),
      (n) => (s = n),
    );
    expect(s).toEqual({ sysop: false, pending: false, known: true });
  });
});
