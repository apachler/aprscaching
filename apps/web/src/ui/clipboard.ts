// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * copyText — clipboard write that reports the truth (ui-ux.md §1.7: no lying feedback). The
 * Clipboard API is absent on insecure contexts and can reject; callers toast success OR failure
 * from the resolved boolean instead of announcing "copied" unconditionally.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
