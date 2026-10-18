// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The app's landing replacing the prerendered copy (#landing-pre, vite-prerender.ts). A visitor on a slow phone uses
 * that copy while the app loads, so the swap carries over what they did with it: the callsign typed so far, how far
 * the page is scrolled, and the field they were typing in. Run before the browser paints the app's copy, so the
 * page never shows the top of a blank form in between.
 */
export function takeOverLanding(pre: HTMLElement, app: ParentNode): void {
  const typed = pre.querySelector<HTMLInputElement>("#landing-call");
  const field = app.querySelector<HTMLInputElement>("#landing-call");
  // a callsign the app's landing already holds is newer than the copy's
  if (typed && field && typed.value && !field.value) field.value = typed.value;

  const from = pre.querySelector(".landing");
  const to = app.querySelector(".landing");
  const scrolled = from?.scrollTop ?? 0;

  const focused = document.activeElement;
  const refocus = focused instanceof HTMLElement && pre.contains(focused) && focused.id ? focused.id : null;
  const selection =
    focused instanceof HTMLInputElement && focused === typed ? [typed.selectionStart, typed.selectionEnd] : null;

  pre.remove();

  if (to && scrolled) to.scrollTop = scrolled;
  if (refocus) {
    const target = app.querySelector<HTMLElement>(`#${CSS.escape(refocus)}`);
    target?.focus({ preventScroll: true });
    if (selection && target instanceof HTMLInputElement && selection[0] != null)
      target.setSelectionRange(selection[0], selection[1] ?? selection[0]);
  }
}
