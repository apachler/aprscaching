// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { PASSKEY_PROBLEM_TEXT, passkeyErrorText, passkeyProblem, withoutUrls } from "../src/identity/passkeySupport.js";

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

describe("passkeyErrorText", () => {
  const server = (e: unknown) => (e as Error).message;

  it("reads a browser refusal by its DOMException name, never its message", () => {
    const chromium = new DOMException(
      "The operation either timed out or was not allowed. See: https://www.w3.org/TR/webauthn-2/#sctn-privacy-considerations-client.",
      "NotAllowedError",
    );
    expect(passkeyErrorText(chromium, server)).toMatch(/cancelled/);
    expect(passkeyErrorText(new DOMException("x", "AbortError"), server)).toMatch(/interrupted/);
    expect(passkeyErrorText(new DOMException("x", "InvalidStateError"), server)).toBe(
      "This passkey is already registered on this device.",
    );
    expect(passkeyErrorText(new DOMException("y", "UnknownError"), server)).toMatch(/did not work/);
  });

  it("shows the server's reason without a bare URL", () => {
    expect(passkeyErrorText(new Error("callsign already claimed"), server)).toBe("callsign already claimed");
    for (const name of ["NotAllowedError", "AbortError", "InvalidStateError", "SecurityError", "Other"])
      expect(passkeyErrorText(new DOMException("see https://example.test", name), server)).not.toMatch(/https?:/);
    expect(passkeyErrorText(new Error("refused. See: https://example.test/x"), server)).toBe("refused.");
    expect(withoutUrls("Refused. See: https://www.w3.org/TR/webauthn-2/ for details")).toBe("Refused. for details");
  });
});
