// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { PASSKEY_PROBLEM_TEXT, passkeyProblem } from "../src/identity/passkeySupport.js";

describe("passkeyProblem", () => {
  it("names an insecure page first, whatever the browser offers", () => {
    expect(passkeyProblem({ isSecureContext: false, PublicKeyCredential: function () {} })).toBe("insecure");
    expect(passkeyProblem({ isSecureContext: false })).toBe("insecure");
  });

  it("names a browser that offers no passkeys", () => {
    expect(passkeyProblem({ isSecureContext: true })).toBe("unsupported");
  });

  it("is null where passkeys work", () => {
    expect(passkeyProblem({ isSecureContext: true, PublicKeyCredential: function () {} })).toBeNull();
  });

  it("says why in one line and points to the one-time sign-in link", () => {
    for (const text of Object.values(PASSKEY_PROBLEM_TEXT)) {
      expect(text).not.toMatch(/\n/);
      expect(text).toMatch(/one-time sign-in link/);
    }
    expect(PASSKEY_PROBLEM_TEXT.insecure).toMatch(/https/);
    expect(PASSKEY_PROBLEM_TEXT.unsupported).toMatch(/browser offers no passkeys/);
  });
});
