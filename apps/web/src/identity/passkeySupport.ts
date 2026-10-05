// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Why passkeys are unavailable, when they are. WebAuthn exists only in a secure context (https, or
 * localhost), and some browsers — privacy-hardened Chromium builds among them — ship without it even
 * there. Either way the one-time sign-in link by email (or one the sysop mints) still works, and the sign-in
 * panel says so. An instance reached over plain http on HAMNET may also have an https address that takes them.
 */
export type PasskeyProblem = "insecure" | "unsupported";

/** One line each: why there is no passkey button, and what to use instead. */
export const PASSKEY_PROBLEM_TEXT: Record<PasskeyProblem, string> = {
  insecure:
    "Passkeys need a secure page (https or localhost). Use the one-time sign-in link by email, or one from the sysop, or open this instance's https address.",
  unsupported: "This browser offers no passkeys. Use the one-time sign-in link by email instead.",
};

/** Null when a passkey can be used here. */
export function passkeyProblem(
  env: { isSecureContext?: boolean; PublicKeyCredential?: unknown } = globalThis,
): PasskeyProblem | null {
  if (env.isSecureContext === false) return "insecure";
  if (!env.PublicKeyCredential) return "unsupported";
  return null;
}

/** What the browser's WebAuthn errors mean to the person holding the device, by `DOMException` name. */
const CEREMONY_ERROR_TEXT: Record<string, string> = {
  NotAllowedError: "Passkey cancelled, or the browser stopped waiting for it. Try again when you're ready.",
  AbortError: "The passkey request was interrupted. Try again.",
  InvalidStateError: "This passkey is already registered on this device.",
  SecurityError: "This page's address can't use passkeys. Use the one-time sign-in link by email instead.",
  NotSupportedError:
    "This device offers no passkey the instance accepts. Use the one-time sign-in link by email instead.",
};
const CEREMONY_ERROR_OTHER =
  "The passkey did not work in this browser. Try again, or use the one-time sign-in link by email.";

/** Drop the links a browser appends to its own error text: a bare URL tells the person nothing. */
export function withoutUrls(text: string): string {
  return text
    .replace(/\s*(?:See:?\s*)?https?:\/\/\S+/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/**
 * The line to show when a passkey ceremony fails. A browser refusal is a `DOMException`, told apart by its
 * name, never by its message, which differs between browsers and carries a link to the spec. Anything
 * else is the server's reason, read with `serverText`.
 */
export function passkeyErrorText(e: unknown, serverText: (e: unknown) => string): string {
  if (typeof DOMException !== "undefined" && e instanceof DOMException)
    return CEREMONY_ERROR_TEXT[e.name] ?? CEREMONY_ERROR_OTHER;
  return withoutUrls(serverText(e)) || CEREMONY_ERROR_OTHER;
}
