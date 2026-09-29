// SPDX-License-Identifier: MIT
import { describe, it, expect } from "vitest";
import { baseCall } from "../src/index.js";

describe("baseCall", () => {
  it.each([
    ["OE8APR", "OE8APR"],
    ["oe8apr-7", "OE8APR"],
    [" OE8APR-10 ", "OE8APR"],
    ["OE8XXX-10*", "OE8XXX"],
    ["WIDE1-1*", "WIDE1"],
    ["", ""],
  ])("%j → %j", (call, base) => expect(baseCall(call)).toBe(base));
});
