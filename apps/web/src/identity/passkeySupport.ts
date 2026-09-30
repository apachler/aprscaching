// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Why passkeys are unavailable, when they are. WebAuthn exists only in a secure context (https, or
 * localhost), and some browsers — privacy-hardened Chromium builds among them — ship without it even
 * there. Either way the one-time sign-in link by email still works, and the sign-in panel says so.
 */
export type PasskeyProblem = "insecure" | "unsupported";

/** One line each: why there is no passkey button, and what to use instead. */
export const PASSKEY_PROBLEM_TEXT: Record<PasskeyProblem, string> = {
  insecure: "Passkeys need a secure page (https or localhost). Use the one-time sign-in link by email instead.",
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
