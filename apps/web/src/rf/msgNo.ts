// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The next APRS message number for a message sent from this browser: 1 to 99999, counting on across sessions so a
 * station that keeps recent numbers to drop repeats does not drop a new message. Without storage the count starts
 * from a random number instead.
 */
const KEY = "acs-msgno";
let fallback = 1 + Math.floor(Math.random() * 99_999);

export function nextMsgNo(): string {
  let n: number;
  try {
    n = (Number(localStorage.getItem(KEY)) || Math.floor(Math.random() * 99_999)) % 99_999;
    n += 1;
    localStorage.setItem(KEY, String(n));
  } catch {
    fallback = (fallback % 99_999) + 1;
    n = fallback;
  }
  return String(n);
}
